/**
 * Frameback review flow – the single source of truth for versions and approvals.
 * (docs/redesign/PLAN.md §3.2–3.3)
 *
 * Rules:
 *  - The "current" version of a group is its highest version with status READY.
 *    Uploading/processing/failed versions are never current.
 *  - Clients may only decide on the current version, and only while the studio has an
 *    open review round for exactly that version ("Zur Freigabe gesendet").
 *  - Admins (UI, Resolve MCP via PATCH /api/videos/:id) can override any version.
 *    Approval is ALWAYS exclusive per group (also enforced by a partial unique index).
 *  - A new version supersedes an open round only when it becomes READY, in the same
 *    transaction as the READY write (markReady), so aborted uploads never end a round
 *    and a decision can never slip in between.
 *  - Legacy fields Video.approved / approvedAt are derived here, never written elsewhere.
 *
 * Concurrency protocol: every mutation runs in one interactive transaction that locks the
 * affected VideoGroup row(s) FOR UPDATE (several groups: sorted by id), then re-reads the
 * video and verifies it still belongs to the locked group.
 */
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient, ReviewOutcome, ReviewState } from '@prisma/client'
import { prisma as defaultPrisma } from './db' // relative: also loaded by the worker (no @/ alias there)

type Tx = Prisma.TransactionClient
type Db = PrismaClient

export type ReviewErrorCode =
  | 'VIDEO_NOT_FOUND'
  | 'NO_GROUP'
  | 'NOT_READY'
  | 'NOT_CURRENT'
  | 'NO_OPEN_REQUEST'
  | 'ALREADY_IN_REVIEW'
  | 'VERIFICATION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'INVALID_COMMENTS'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_MISMATCH'
  | 'CONCURRENT_UPDATE'
  | 'RULE_NOT_SUPPORTED'
  | 'PROJECT_NOT_FOUND'

export class ReviewError extends Error {
  constructor(public code: ReviewErrorCode, message: string) {
    super(message)
    this.name = 'ReviewError'
  }
}

export interface ClientActor {
  /** Unverified display name (from the share session or form) */
  name: string
  /** Only from a verified OTP share session – never from a request body */
  verifiedEmail?: string | null
  viewerKeyHash?: string | null
  ip?: string | null
}

export const hashViewerKey = (key: string) => createHash('sha256').update(key).digest('hex')

const KEY_PATTERN = /^[A-Za-z0-9:_-]{8,200}$/
/** Validate a client-supplied Idempotency-Key, or generate one when absent. */
export function idempotencyKeyFrom(header: string | null | undefined) {
  if (header == null || header === '') return randomUUID()
  if (!KEY_PATTERN.test(header)) throw new ReviewError('INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key')
  return header
}

// ---------------------------------------------------------------------------
// locking helpers
// ---------------------------------------------------------------------------

/**
 * Lock order is always: project row, then group rows sorted by id.
 * Per-video operations take the project lock SHARED (they run in parallel across groups);
 * project-wide operations (unapproveProject) take it EXCLUSIVE and so see every group,
 * including ones created concurrently.
 */
async function lockProject(tx: Tx, projectId: string, mode: 'SHARE' | 'UPDATE') {
  if (mode === 'SHARE') await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR SHARE`
  else await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`
}

async function lockGroups(tx: Tx, groupIds: string[]) {
  for (const id of [...new Set(groupIds)].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "VideoGroup" WHERE "id" = ${id} FOR UPDATE`
  }
}

const videoSelect = {
  id: true, projectId: true, name: true, groupId: true, version: true, status: true, reviewState: true, approved: true,
} as const

/**
 * Lock the video's group (plus extra groups, all in id order), then re-read the video and
 * verify it did not move meanwhile. On a concurrent move it throws CONCURRENT_UPDATE and
 * runTx restarts the WHOLE transaction (re-locking in a fresh, globally ordered set) –
 * never lock additional groups out of order inside the same transaction.
 */
async function lockedVideo(tx: Tx, videoId: string, extraGroups: string[] = []) {
  const before = await tx.video.findUnique({ where: { id: videoId }, select: { groupId: true, projectId: true } })
  if (!before) throw new ReviewError('VIDEO_NOT_FOUND', 'Video not found')
  if (!before.groupId) throw new ReviewError('NO_GROUP', 'Video has no group')
  await lockProject(tx, before.projectId, 'SHARE')
  await lockGroups(tx, [before.groupId, ...extraGroups])
  const video = await tx.video.findUnique({ where: { id: videoId }, select: videoSelect })
  if (!video) throw new ReviewError('VIDEO_NOT_FOUND', 'Video not found')
  if (video.groupId !== before.groupId) throw new ReviewError('CONCURRENT_UPDATE', 'Video was moved concurrently, please retry')
  return video
}

const isRetryable = (e: unknown) =>
  (e instanceof ReviewError && e.code === 'CONCURRENT_UPDATE') ||
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') || // write conflict / deadlock
  /deadlock detected|40P01/.test(String((e as Error)?.message ?? ''))

/** Interactive transaction, restarted completely (max 3 attempts) on concurrent moves or deadlocks. */
async function runTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(fn)
    } catch (error) {
      if (attempt >= 3 || !isRetryable(error)) throw error
    }
  }
}

/** Fields only this module may write. */
const PROTECTED = ['id', 'approved', 'approvedAt', 'reviewState', 'groupId', 'version', 'projectId', 'name'] as const
function stripProtected<T extends Record<string, unknown>>(data: T): T {
  const copy = { ...data }
  for (const k of PROTECTED) delete (copy as Record<string, unknown>)[k]
  return copy
}

async function currentIn(tx: Tx | Db, groupId: string) {
  return tx.video.findFirst({
    where: { groupId, status: 'READY' },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, reviewState: true },
  })
}

/** Highest READY version of a group, or null. */
export const currentVersion = (groupId: string, db: Tx | Db = defaultPrisma) => currentIn(db, groupId)

const openRequest = (tx: Tx, groupId: string) => tx.reviewRequest.findFirst({ where: { groupId, closedAt: null } })

async function closeRequest(tx: Tx, requestId: string, outcome: ReviewOutcome) {
  await tx.reviewRequest.update({ where: { id: requestId }, data: { closedAt: new Date(), outcome } })
}

/** Derive the legacy fields from the review state. Only writer of approved/approvedAt. */
async function setState(tx: Tx, videoId: string, state: ReviewState) {
  await tx.video.update({
    where: { id: videoId },
    data: { reviewState: state, approved: state === 'APPROVED', approvedAt: state === 'APPROVED' ? new Date() : null },
  })
}

/** Exclusive approval inside a locked group: others leave APPROVED first (partial unique index). */
async function approveExclusively(tx: Tx, groupId: string, videoId: string) {
  const others = await tx.video.findMany({
    where: { groupId, id: { not: videoId }, approved: true },
    select: { id: true },
  })
  for (const o of others) await setState(tx, o.id, 'DRAFT')
  await setState(tx, videoId, 'APPROVED')
}

const isUniqueViolation = (e: unknown, field?: string) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' &&
  (!field || JSON.stringify(e.meta?.target ?? '').includes(field))

// ---------------------------------------------------------------------------
// groups and versions
// ---------------------------------------------------------------------------

/**
 * Find or create the group for (projectId, name). Atomic under concurrency: Prisma's upsert
 * is not (two first uploads of a new video would collide), INSERT … ON CONFLICT is.
 */
export async function ensureGroup(projectId: string, name: string, db: Tx | Db = defaultPrisma) {
  const existing = await db.videoGroup.findUnique({ where: { projectId_name: { projectId, name } }, select: { id: true } })
  if (existing) return existing.id
  await db.$executeRaw`
    INSERT INTO "VideoGroup" ("id", "projectId", "name", "sortOrder", "createdAt", "updatedAt")
    VALUES (${'vg_' + randomUUID()}, ${projectId}, ${name},
            (SELECT count(*)::int FROM "VideoGroup" WHERE "projectId" = ${projectId}), now(), now())
    ON CONFLICT ("projectId", "name") DO NOTHING`
  const group = await db.videoGroup.findUniqueOrThrow({ where: { projectId_name: { projectId, name } }, select: { id: true } })
  return group.id
}

/**
 * Create a new version of (projectId, name) with the next version number, allocated under
 * the group lock. The only path that creates Video rows.
 */
export async function createVersion(
  params: {
    projectId: string
    name: string
    versionLabel?: string | null
    data: Omit<Prisma.VideoUncheckedCreateInput, 'projectId' | 'name' | 'groupId' | 'version' | 'versionLabel'>
  },
  db: Db = defaultPrisma
) {
  return runTx(db, async (tx) => {
    if ((params.data as { status?: string }).status === 'READY') {
      throw new ReviewError('NOT_READY', 'New versions start as UPLOADING/PROCESSING; READY is set by markReady')
    }
    await lockProject(tx, params.projectId, 'SHARE')
    const groupId = await ensureGroup(params.projectId, params.name, tx)
    await lockGroups(tx, [groupId])
    const last = await tx.video.findFirst({ where: { groupId }, orderBy: { version: 'desc' }, select: { version: true } })
    const version = (last?.version ?? 0) + 1
    return tx.video.create({
      data: {
        ...(stripProtected(params.data as Record<string, unknown>) as typeof params.data),
        projectId: params.projectId,
        name: params.name,
        groupId,
        version,
        versionLabel: params.versionLabel?.trim() || `v${version}`,
      },
    })
  })
}

/**
 * Worker: write the final processing result (status READY) and, in the same transaction,
 * supersede an open round of an older version if this one is now current.
 */
export async function markReady(videoId: string, data: Prisma.VideoUncheckedUpdateInput, db: Db = defaultPrisma) {
  return runTx(db, async (tx) => {
    const video = await lockedVideo(tx, videoId)
    await tx.video.update({ where: { id: videoId }, data: { ...stripProtected(data as Record<string, unknown>), status: 'READY' } })
    const current = await currentIn(tx, video.groupId)
    if (current?.id !== video.id) return { superseded: null as string | null }
    const open = await openRequest(tx, video.groupId)
    if (!open || open.videoId === video.id) return { superseded: null }
    await closeRequest(tx, open.id, 'SUPERSEDED')
    const old = await tx.video.findUnique({ where: { id: open.videoId }, select: { reviewState: true } })
    if (old?.reviewState === 'IN_REVIEW') await setState(tx, open.videoId, 'DRAFT')
    return { superseded: open.videoId }
  })
}

// ---------------------------------------------------------------------------
// studio actions
// ---------------------------------------------------------------------------

/** "Zur Freigabe senden": open a review round (rule ANY) for the current version. */
export async function requestReview(
  params: { videoId: string; adminUserId: string; actorName?: string; versionNote?: string | null },
  db: Db = defaultPrisma
) {
  return runTx(db, async (tx) => {
    const video = await lockedVideo(tx, params.videoId)
    if (video.status !== 'READY') throw new ReviewError('NOT_READY', 'Version is still processing')
    const current = await currentIn(tx, video.groupId)
    if (current?.id !== video.id) throw new ReviewError('NOT_CURRENT', 'Only the current version can be sent for approval')
    const open = await openRequest(tx, video.groupId)
    if (open) {
      if (open.videoId === video.id) throw new ReviewError('ALREADY_IN_REVIEW', 'Version is already waiting for approval')
      await closeRequest(tx, open.id, 'SUPERSEDED')
      await setState(tx, open.videoId, 'DRAFT')
    }
    if (params.versionNote !== undefined) {
      await tx.video.update({ where: { id: video.id }, data: { versionNote: params.versionNote?.trim().slice(0, 500) || null } })
    }
    const request = await tx.reviewRequest.create({
      data: { groupId: video.groupId, videoId: video.id, requestedById: params.adminUserId, rule: 'ANY' },
    })
    await setState(tx, video.id, 'IN_REVIEW')
    await tx.reviewDecision.create({
      data: {
        requestId: request.id, videoId: video.id, kind: 'SENT_FOR_REVIEW',
        actorName: params.actorName || 'Admin', adminUserId: params.adminUserId, idempotencyKey: `sent:${request.id}`,
      },
    })
    return request
  })
}

/** Studio takes a version back out of review ("Zurückziehen"). */
export async function withdrawReview(
  params: { videoId: string; adminUserId: string; actorName?: string },
  db: Db = defaultPrisma
) {
  return runTx(db, async (tx) => {
    const video = await lockedVideo(tx, params.videoId)
    const open = await openRequest(tx, video.groupId)
    if (!open || open.videoId !== video.id) throw new ReviewError('NO_OPEN_REQUEST', 'Version is not waiting for approval')
    await closeRequest(tx, open.id, 'WITHDRAWN')
    await setState(tx, video.id, 'DRAFT')
    await tx.reviewDecision.create({
      data: {
        requestId: open.id, videoId: video.id, kind: 'WITHDRAWN',
        actorName: params.actorName || 'Admin', adminUserId: params.adminUserId, idempotencyKey: `withdrawn:${open.id}`,
      },
    })
  })
}

async function overrideInTx(
  tx: Tx,
  video: { id: string; groupId: string; reviewState: ReviewState; approved: boolean },
  approved: boolean,
  admin: { adminUserId?: string | null; actorName?: string }
) {
  const open = await openRequest(tx, video.groupId)
  if (approved) {
    const otherApproved = await tx.video.count({ where: { groupId: video.groupId, id: { not: video.id }, approved: true } })
    if (video.reviewState === 'APPROVED' && video.approved && otherApproved === 0 && !open) return false // no-op
    if (open) {
      await closeRequest(tx, open.id, open.videoId === video.id ? 'APPROVED' : 'WITHDRAWN')
      if (open.videoId !== video.id) await setState(tx, open.videoId, 'DRAFT')
    }
    await approveExclusively(tx, video.groupId, video.id)
  } else {
    const openForThis = open?.videoId === video.id
    if (video.reviewState === 'DRAFT' && !video.approved && !openForThis) return false // no-op
    if (openForThis) await closeRequest(tx, open!.id, 'WITHDRAWN')
    await setState(tx, video.id, 'DRAFT')
  }
  await tx.reviewDecision.create({
    data: {
      requestId: open?.videoId === video.id ? open.id : null,
      videoId: video.id,
      kind: 'ADMIN_OVERRIDE',
      actorName: admin.actorName || 'Admin',
      adminUserId: admin.adminUserId ?? null,
      note: approved ? 'approved' : 'unapproved',
      idempotencyKey: `override:${randomUUID()}`,
    },
  })
  return true
}

/**
 * Admin edit of one version (admin UI, Resolve MCP `PATCH /api/videos/:id`), atomic:
 *  - name: moves THIS version to the group of the new name (legacy name-based semantics,
 *    which the MCP relies on). An open round for it is withdrawn; if the target group
 *    already has an approved version, the moved one loses its approval; a clashing
 *    version number is refused (VERSION_CONFLICT).
 *  - approved: override for any version, always exclusive, never notifies, no-op if unchanged.
 * Returns the final approval of this version and `unapproved`: the ids of OTHER versions
 * that lost their approval through this edit (exclusivity), empty if none.
 */
export async function adminUpdateVersion(
  params: {
    videoId: string
    name?: string
    versionLabel?: string
    approved?: boolean
    adminUserId?: string | null
    actorName?: string
  },
  db: Db = defaultPrisma
) {
  return runTx(db, async (tx) => {
    const pre = await tx.video.findUnique({ where: { id: params.videoId }, select: { projectId: true } })
    if (!pre) throw new ReviewError('VIDEO_NOT_FOUND', 'Video not found')
    const newName = params.name?.trim()
    // The target group is derived from the requested NAME (not from a pre-lock comparison),
    // so a concurrent rename cannot leave name and group out of sync.
    const targetGroupId = newName !== undefined ? await ensureGroup(pre.projectId, newName, tx) : null
    const video = await lockedVideo(tx, params.videoId, targetGroupId ? [targetGroupId] : [])
    // Both groups are locked: snapshot approvals to report what this edit took away from
    // OTHER versions (exclusivity), so callers like the Resolve MCP can show it.
    const touchedGroups = [video.groupId, ...(targetGroupId ? [targetGroupId] : [])]
    const approvedIn = async () =>
      (await tx.video.findMany({ where: { groupId: { in: touchedGroups }, approved: true }, select: { id: true } }))
        .map((v) => v.id)
    const approvedBefore = await approvedIn()

    let effectiveGroup = video.groupId
    if (targetGroupId && targetGroupId !== video.groupId) {
      const clash = await tx.video.count({ where: { groupId: targetGroupId, version: video.version } })
      if (clash) throw new ReviewError('VERSION_CONFLICT', `"${newName}" already has a version ${video.version}`)
      const open = await openRequest(tx, video.groupId)
      if (open?.videoId === video.id) await closeRequest(tx, open.id, 'WITHDRAWN')
      const targetHasApproved = await tx.video.count({ where: { groupId: targetGroupId, approved: true } })
      if (video.approved && targetHasApproved) await setState(tx, video.id, 'DRAFT')
      else if (video.reviewState === 'IN_REVIEW') await setState(tx, video.id, 'DRAFT')
      await tx.video.update({ where: { id: video.id }, data: { name: newName, groupId: targetGroupId } })
      effectiveGroup = targetGroupId
      // If the moved version is now the current one of the target group, an open round of an
      // older target version is stale: supersede it (same rule as markReady).
      const targetOpen = await openRequest(tx, targetGroupId)
      const targetCurrent = await currentIn(tx, targetGroupId)
      if (targetOpen && targetCurrent?.id === video.id && targetOpen.videoId !== video.id) {
        await closeRequest(tx, targetOpen.id, 'SUPERSEDED')
        await setState(tx, targetOpen.videoId, 'DRAFT')
      }
    } else if (newName !== undefined && newName !== video.name) {
      // same group, different spelling stored on this row only (should not happen; keep consistent)
      await tx.video.update({ where: { id: video.id }, data: { name: newName } })
    }

    if (params.versionLabel !== undefined) {
      await tx.video.update({ where: { id: video.id }, data: { versionLabel: params.versionLabel.trim() } })
    }

    let changedApproval = false
    if (params.approved !== undefined) {
      const fresh = await tx.video.findUniqueOrThrow({ where: { id: video.id }, select: videoSelect })
      changedApproval = await overrideInTx(
        tx,
        { ...fresh, groupId: effectiveGroup },
        params.approved,
        { adminUserId: params.adminUserId, actorName: params.actorName }
      )
    }
    const approvedAfter = new Set(await approvedIn())
    return {
      changedApproval,
      approved: approvedAfter.has(video.id),
      unapproved: approvedBefore.filter((id) => id !== video.id && !approvedAfter.has(id)),
    }
  })
}

/** Admin approval override for one version (always exclusive). */
export const adminOverride = (
  params: { videoId: string; approved: boolean; adminUserId?: string | null; actorName?: string },
  db: Db = defaultPrisma
) => adminUpdateVersion(params, db)

/**
 * Admin "unapprove project": all groups locked together; every approved or in-review
 * version back to DRAFT, open rounds withdrawn, project status reset – one transaction.
 */
export async function unapproveProject(
  params: { projectId: string; adminUserId?: string | null; actorName?: string; resetVideos?: boolean },
  db: Db = defaultPrisma
) {
  return runTx(db, async (tx) => {
    await lockProject(tx, params.projectId, 'UPDATE')
    let count = 0
    if (params.resetVideos !== false) {
      const groups = await tx.videoGroup.findMany({ where: { projectId: params.projectId }, select: { id: true } })
      await lockGroups(tx, groups.map((g) => g.id))
      const open = await tx.reviewRequest.findMany({ where: { groupId: { in: groups.map((g) => g.id) }, closedAt: null } })
      for (const r of open) await closeRequest(tx, r.id, 'WITHDRAWN')
      const affected = await tx.video.findMany({
        where: { projectId: params.projectId, OR: [{ approved: true }, { reviewState: { in: ['IN_REVIEW', 'APPROVED'] } }] },
        select: { id: true, approved: true },
      })
      for (const v of affected) {
        await setState(tx, v.id, 'DRAFT')
        if (v.approved) count++
        await tx.reviewDecision.create({
          data: {
            videoId: v.id, kind: 'ADMIN_OVERRIDE', actorName: params.actorName || 'Admin',
            adminUserId: params.adminUserId ?? null, note: 'project unapproved', idempotencyKey: `override:${randomUUID()}`,
          },
        })
      }
    }
    await tx.project.update({
      where: { id: params.projectId },
      data: { status: 'IN_REVIEW', approvedAt: null, approvedVideoId: null },
    })
    return count
  })
}

/**
 * Studio "Projekt freigeben": the current version of every video counts as approved
 * (e.g. the client agreed by mail or phone). All groups locked together, each change is
 * recorded as ADMIN_OVERRIDE; never notifies. Archived/share-only status stays as it is.
 * Returns the video ids whose approval changed (for clean-preview jobs).
 */
export async function approveProjectAsStudio(
  params: { projectId: string; adminUserId?: string | null; actorName?: string },
  db: Db = defaultPrisma
) {
  return runTx(db, async (tx) => {
    await lockProject(tx, params.projectId, 'UPDATE')
    const project = await tx.project.findUnique({ where: { id: params.projectId }, select: { status: true } })
    if (!project) throw new ReviewError('PROJECT_NOT_FOUND', 'Project not found')
    const groups = await tx.videoGroup.findMany({ where: { projectId: params.projectId }, select: { id: true } })
    await lockGroups(tx, groups.map((g) => g.id))
    const approvedIds: string[] = []
    let current: string | null = null
    for (const g of groups) {
      const cur = await currentIn(tx, g.id)
      if (!cur) continue // nothing playable yet (still processing): nothing to approve
      const fresh = await tx.video.findUniqueOrThrow({ where: { id: cur.id }, select: videoSelect })
      if (await overrideInTx(tx, { ...fresh, groupId: g.id }, true, params)) approvedIds.push(cur.id)
      current ??= cur.id
    }
    if (current && project.status === 'IN_REVIEW') {
      await tx.project.update({
        where: { id: params.projectId },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedVideoId: approvedIds[0] ?? current },
      })
    }
    return { approvedIds }
  })
}

// ---------------------------------------------------------------------------
// client decisions
// ---------------------------------------------------------------------------

export interface ClientDecisionInput {
  videoId: string
  kind: 'APPROVE' | 'REQUEST_CHANGES'
  actor: ClientActor
  /** Validated with idempotencyKeyFrom(); namespaced per video and action internally */
  idempotencyKey: string
  note?: string | null
  /** Client-visible comments of this version handed over with "Änderungen anfordern" */
  commentIds?: string[]
  requireVerifiedApproval?: boolean
}

export interface DecisionResult {
  decisionId: string
  /** false = idempotent replay; callers must not repeat side effects (notifications) */
  applied: boolean
}

/** One global key space for client decisions: reuse for another request is detected, not hidden. */
const clientKey = (idempotencyKey: string) => `client:${idempotencyKey}`

async function replayOrMismatch(
  db: Tx | Db, key: string, fp: { videoId: string; kind: string; viewerKeyHash?: string | null; note?: string | null }
): Promise<DecisionResult | null> {
  const existing = await db.reviewDecision.findUnique({ where: { idempotencyKey: key } })
  if (!existing) return null
  const sameViewer = (existing.viewerKeyHash ?? null) === (fp.viewerKeyHash ?? null)
  const sameNote = fp.note === undefined || (existing.note ?? null) === (fp.note?.trim().slice(0, 2000) || null)
  if (existing.videoId !== fp.videoId || existing.kind !== fp.kind || !sameViewer || !sameNote) {
    throw new ReviewError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was used for a different request')
  }
  return { decisionId: existing.id, applied: false }
}

/** Client approves or requests changes. Only for the current version with an open round. */
export async function clientDecide(input: ClientDecisionInput, db: Db = defaultPrisma): Promise<DecisionResult> {
  const key = clientKey(input.idempotencyKey)
  const fp = { videoId: input.videoId, kind: input.kind, viewerKeyHash: input.actor.viewerKeyHash, note: input.note ?? null }
  try {
    return await runTx(db, async (tx) => {
      const video = await lockedVideo(tx, input.videoId)
      const replay = await replayOrMismatch(tx, key, fp)
      if (replay) return replay

      const current = await currentIn(tx, video.groupId)
      if (current?.id !== video.id) throw new ReviewError('NOT_CURRENT', 'A newer version exists – please review the current version')
      const open = await openRequest(tx, video.groupId)
      if (!open || open.videoId !== video.id) throw new ReviewError('NO_OPEN_REQUEST', 'This version has not been sent for approval')
      if (open.rule !== 'ANY') throw new ReviewError('RULE_NOT_SUPPORTED', 'Approval rounds with several required approvers are not supported yet')
      if (input.kind === 'APPROVE' && input.requireVerifiedApproval && !input.actor.verifiedEmail) {
        throw new ReviewError('VERIFICATION_REQUIRED', 'Approval requires a verified email address')
      }

      const ids = [...new Set(input.commentIds ?? [])]
      const comments = ids.length
        ? await tx.comment.findMany({
            where: { id: { in: ids }, videoId: video.id, deletedAt: null, isInternal: false },
            select: { id: true, content: true },
          })
        : []
      if (comments.length !== ids.length) throw new ReviewError('INVALID_COMMENTS', 'Unknown or hidden comments in request')

      const decision = await tx.reviewDecision.create({
        data: {
          requestId: open.id,
          videoId: video.id,
          kind: input.kind,
          actorName: input.actor.name.trim().slice(0, 100) || 'Client',
          verifiedEmail: input.actor.verifiedEmail ?? null,
          viewerKeyHash: input.actor.viewerKeyHash ?? null,
          ip: input.actor.ip ?? null,
          note: input.note?.trim().slice(0, 2000) || null,
          idempotencyKey: key,
          comments: { create: comments.map((c) => ({ commentId: c.id, textSnapshot: c.content })) },
        },
      })
      if (input.kind === 'APPROVE') {
        await approveExclusively(tx, video.groupId, video.id)
        await closeRequest(tx, open.id, 'APPROVED')
      } else {
        await setState(tx, video.id, 'CHANGES_REQUESTED')
        await closeRequest(tx, open.id, 'CHANGES_REQUESTED')
      }
      return { decisionId: decision.id, applied: true }
    })
  } catch (error) {
    // Two requests with the same key raced: the loser rolled back completely; report the winner.
    if (isUniqueViolation(error, 'idempotencyKey')) {
      const replay = await replayOrMismatch(db, key, fp)
      if (replay) return replay
    }
    throw error
  }
}

/**
 * Legacy client approval while the project has reviewFlow off: any version may be approved
 * (unchanged behaviour), but state and audit entry are recorded consistently.
 */
export async function legacyClientApprove(
  params: { videoId: string; actor: ClientActor; idempotencyKey: string },
  db: Db = defaultPrisma
): Promise<DecisionResult> {
  const key = clientKey(params.idempotencyKey)
  const fp = { videoId: params.videoId, kind: 'APPROVE', viewerKeyHash: params.actor.viewerKeyHash }
  try {
    return await runTx(db, async (tx) => {
      const video = await lockedVideo(tx, params.videoId)
      const replay = await replayOrMismatch(tx, key, fp)
      if (replay) return replay
      const open = await openRequest(tx, video.groupId)
      if (open) {
        await closeRequest(tx, open.id, open.videoId === video.id ? 'APPROVED' : 'WITHDRAWN')
        if (open.videoId !== video.id) await setState(tx, open.videoId, 'DRAFT')
      }
      await approveExclusively(tx, video.groupId, video.id)
      const decision = await tx.reviewDecision.create({
        data: {
          requestId: open?.videoId === video.id ? open.id : null,
          videoId: video.id,
          kind: 'APPROVE',
          actorName: params.actor.name.trim().slice(0, 100) || 'Client',
          viewerKeyHash: params.actor.viewerKeyHash ?? null,
          ip: params.actor.ip ?? null,
          note: 'legacy flow',
          idempotencyKey: key,
        },
      })
      return { decisionId: decision.id, applied: true }
    })
  } catch (error) {
    if (isUniqueViolation(error, 'idempotencyKey')) {
      const replay = await replayOrMismatch(db, key, fp)
      if (replay) return replay
    }
    throw error
  }
}
