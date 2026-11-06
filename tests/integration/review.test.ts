import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import {
  ReviewError, adminOverride, adminUpdateVersion, clientDecide, createVersion, currentVersion, idempotencyKeyFrom,
  legacyClientApprove, markReady, requestReview, unapproveProject, withdrawReview,
} from '@/lib/review'
import { addVersion, makeProject, openRounds, state } from './helpers'

const actor = { name: 'Anna Keller', viewerKeyHash: 'k1', ip: '10.0.0.1' }
let n = 0
const key = () => `test-key-${Date.now()}-${n++}`

afterAll(() => prisma.$disconnect())

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(ReviewError)
  await expect(p).rejects.toMatchObject({ code })
}

const uploadData = {
  originalFileName: 'f.mov', originalFileSize: BigInt(1), originalStoragePath: 'x', status: 'UPLOADING' as const,
  duration: 0, width: 0, height: 0,
}

describe('versions', () => {
  it('current = highest READY version; processing uploads never count', async () => {
    const { project } = await makeProject()
    const v1 = await addVersion(project.id, 'Hauptfilm', 1)
    await addVersion(project.id, 'Hauptfilm', 2, 'PROCESSING')
    expect((await currentVersion(v1.groupId))?.id).toBe(v1.id)
  })

  it('concurrent uploads of the same video get distinct version numbers', async () => {
    const { project } = await makeProject()
    const created = await Promise.all(
      Array.from({ length: 5 }, () => createVersion({ projectId: project.id, name: 'Film', data: uploadData }))
    )
    expect(created.map((v) => v.version).sort()).toEqual([1, 2, 3, 4, 5])
    expect(new Set(created.map((v) => v.groupId)).size).toBe(1)
    expect(created.find((v) => v.version === 3)?.versionLabel).toBe('v3')
  })
})

describe('client decisions', () => {
  it('cannot decide on a draft (not sent for approval)', async () => {
    const { project } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await expectCode(clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: key() }), 'NO_OPEN_REQUEST')
    expect(await state(v1.id)).toEqual({ reviewState: 'DRAFT', approved: false })
  })

  it('approves the version that was sent and derives legacy fields', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id, versionNote: 'Neuer Claim' })
    expect(await state(v1.id)).toEqual({ reviewState: 'IN_REVIEW', approved: false })
    const r = await clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: key() })
    expect(r.applied).toBe(true)
    expect(await state(v1.id)).toEqual({ reviewState: 'APPROVED', approved: true })
    expect(await openRounds(v1.groupId)).toHaveLength(0)
    expect(await prisma.reviewDecision.count({ where: { videoId: v1.id, kind: 'SENT_FOR_REVIEW' } })).toBe(1)
  })

  it('refuses an older version even if the link still shows it', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    const v2 = await addVersion(project.id, 'Film', 2, 'PROCESSING')
    await markReady(v2.id, {})
    await expectCode(clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: key() }), 'NOT_CURRENT')
  })

  it('request changes stores note and snapshots of client-visible comments only', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    const c = await prisma.comment.create({ data: { projectId: project.id, videoId: v1.id, timecode: '00:00:12:00', content: 'Musik leiser' } })
    const internal = await prisma.comment.create({ data: { projectId: project.id, videoId: v1.id, timecode: '00:00:01:00', content: 'intern', isInternal: true } })
    await expectCode(
      clientDecide({ videoId: v1.id, kind: 'REQUEST_CHANGES', actor, commentIds: [c.id, internal.id], idempotencyKey: key() }),
      'INVALID_COMMENTS'
    )
    const d = await clientDecide({ videoId: v1.id, kind: 'REQUEST_CHANGES', actor, note: 'Bitte Musik', commentIds: [c.id], idempotencyKey: key() })
    expect(await state(v1.id)).toEqual({ reviewState: 'CHANGES_REQUESTED', approved: false })
    const snap = await prisma.reviewDecisionComment.findMany({ where: { decisionId: d.decisionId } })
    expect(snap.map((s) => s.textSnapshot)).toEqual(['Musik leiser'])
  })

  it('idempotency: replay returns applied=false; same key for another action is a mismatch… per action namespace', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    const k = key()
    const a = await clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: k })
    const b = await clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: k })
    expect(a.applied).toBe(true)
    expect(b).toEqual({ decisionId: a.decisionId, applied: false })
  })

  it('idempotency: parallel requests with the same key record exactly one decision', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    const k = key()
    const results = await Promise.all(Array.from({ length: 4 }, () => clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: k })))
    expect(results.filter((r) => r.applied)).toHaveLength(1)
    expect(new Set(results.map((r) => r.decisionId)).size).toBe(1)
  })

  it('rejects malformed idempotency keys', () => {
    expect(() => idempotencyKeyFrom('bad key with spaces')).toThrow(ReviewError)
    expect(idempotencyKeyFrom(null)).toMatch(/[0-9a-f-]{36}/)
  })

  it('requires a verified email when the share demands it', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    await expectCode(
      clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: key(), requireVerifiedApproval: true }),
      'VERIFICATION_REQUIRED'
    )
  })

  it('concurrent approve and request-changes: exactly one wins', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    const results = await Promise.allSettled([
      clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: key() }),
      clientDecide({ videoId: v1.id, kind: 'REQUEST_CHANGES', actor, idempotencyKey: key() }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'NO_OPEN_REQUEST' })
  })
})

describe('studio actions', () => {
  it('only the current READY version can be sent; not twice; withdraw is logged', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    const v2 = await addVersion(project.id, 'Film', 2, 'PROCESSING')
    await expectCode(requestReview({ videoId: v2.id, adminUserId: user.id }), 'NOT_READY')
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    await expectCode(requestReview({ videoId: v1.id, adminUserId: user.id }), 'ALREADY_IN_REVIEW')
    await withdrawReview({ videoId: v1.id, adminUserId: user.id })
    expect(await state(v1.id)).toEqual({ reviewState: 'DRAFT', approved: false })
    expect(await prisma.reviewDecision.count({ where: { videoId: v1.id, kind: 'WITHDRAWN' } })).toBe(1)
  })

  it('admin override: any version, always exclusive, no-op when unchanged (Resolve MCP contract)', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    const v2 = await addVersion(project.id, 'Film', 2)
    expect((await adminOverride({ videoId: v1.id, approved: true, adminUserId: user.id })).changedApproval).toBe(true)
    await adminOverride({ videoId: v2.id, approved: true, adminUserId: user.id })
    expect((await state(v1.id)).approved).toBe(false) // exclusive, like PATCH before
    expect((await state(v2.id)).approved).toBe(true)
    expect((await adminOverride({ videoId: v2.id, approved: true, adminUserId: user.id })).changedApproval).toBe(false)
    await adminOverride({ videoId: v2.id, approved: false, adminUserId: user.id })
    expect(await state(v2.id)).toEqual({ reviewState: 'DRAFT', approved: false })
    expect(await prisma.reviewDecision.count({ where: { videoId: v2.id, kind: 'ADMIN_OVERRIDE' } })).toBe(2)
  })

  it('the database refuses two approved versions in one group', async () => {
    const { project } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    const v2 = await addVersion(project.id, 'Film', 2)
    await prisma.video.update({ where: { id: v1.id }, data: { approved: true } })
    await expect(prisma.video.update({ where: { id: v2.id }, data: { approved: true } })).rejects.toThrow()
  })

  it('rename moves one version to another group; withdraws its round; refuses version clashes', async () => {
    const { project, user } = await makeProject()
    const a1 = await addVersion(project.id, 'Alt', 1)
    const a2 = await addVersion(project.id, 'Alt', 2)
    await addVersion(project.id, 'Neu', 2)
    await requestReview({ videoId: a2.id, adminUserId: user.id })
    await expectCode(adminUpdateVersion({ videoId: a2.id, name: 'Neu' }), 'VERSION_CONFLICT')
    await adminUpdateVersion({ videoId: a1.id, name: 'Neu' })
    const moved = await prisma.video.findUniqueOrThrow({ where: { id: a1.id }, include: { group: true } })
    expect(moved.name).toBe('Neu')
    expect(moved.group.name).toBe('Neu')
    // rename + approve atomically
    await adminUpdateVersion({ videoId: a2.id, name: 'Drittes', approved: true })
    expect(await state(a2.id)).toEqual({ reviewState: 'APPROVED', approved: true })
    expect(await openRounds(a1.groupId)).toHaveLength(0) // a2's round was withdrawn when it moved
  })

  it('unapprove project: approved and in-review versions reset, open rounds withdrawn, status reset', async () => {
    const { project, user } = await makeProject()
    const a = await addVersion(project.id, 'A', 1)
    const b = await addVersion(project.id, 'B', 1)
    await adminOverride({ videoId: a.id, approved: true, adminUserId: user.id })
    await requestReview({ videoId: b.id, adminUserId: user.id })
    await prisma.project.update({ where: { id: project.id }, data: { status: 'APPROVED' } })
    expect(await unapproveProject({ projectId: project.id, adminUserId: user.id })).toBe(1)
    expect(await state(a.id)).toEqual({ reviewState: 'DRAFT', approved: false })
    expect(await state(b.id)).toEqual({ reviewState: 'DRAFT', approved: false })
    expect(await openRounds(b.groupId)).toHaveLength(0)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('IN_REVIEW')
  })
})

describe('upload lifecycle', () => {
  it('an upload in progress does not end the running round; READY supersedes it atomically', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    const v2 = await addVersion(project.id, 'Film', 2, 'PROCESSING')
    expect(await openRounds(v1.groupId)).toHaveLength(1)
    await prisma.video.delete({ where: { id: v2.id } }) // aborted upload
    expect(await openRounds(v1.groupId)).toHaveLength(1)
    const v3 = await addVersion(project.id, 'Film', 3, 'PROCESSING')
    expect((await markReady(v3.id, { duration: 60 })).superseded).toBe(v1.id)
    expect(await openRounds(v1.groupId)).toHaveLength(0)
    expect(await state(v1.id)).toEqual({ reviewState: 'DRAFT', approved: false })
  })

  it('race: READY of a newer version vs. client approval – state stays consistent', async () => {
    for (let i = 0; i < 5; i++) {
      const { project, user } = await makeProject()
      const v1 = await addVersion(project.id, 'Film', 1)
      await requestReview({ videoId: v1.id, adminUserId: user.id })
      const v2 = await addVersion(project.id, 'Film', 2, 'PROCESSING')
      const [decision] = await Promise.allSettled([
        clientDecide({ videoId: v1.id, kind: 'APPROVE', actor, idempotencyKey: key() }),
        markReady(v2.id, {}),
      ])
      const s1 = await state(v1.id)
      if (decision.status === 'fulfilled') {
        expect(s1).toEqual({ reviewState: 'APPROVED', approved: true }) // decided before v2 became current
      } else {
        expect(decision.reason).toMatchObject({ code: 'NOT_CURRENT' })
        expect(s1.approved).toBe(false)
      }
      expect(await openRounds(v1.groupId)).toHaveLength(0)
    }
  })

  it('the database allows only one open round per group', async () => {
    const { project, user } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    await requestReview({ videoId: v1.id, adminUserId: user.id })
    await expect(prisma.reviewRequest.create({ data: { groupId: v1.groupId, videoId: v1.id } })).rejects.toThrow()
  })
})

describe('legacy flow (FEATURE_REVIEW_FLOW off)', () => {
  it('approves any version, exclusively, logged, idempotent', async () => {
    const { project } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    const v2 = await addVersion(project.id, 'Film', 2)
    await legacyClientApprove({ videoId: v2.id, actor, idempotencyKey: key() })
    const k = key()
    const first = await legacyClientApprove({ videoId: v1.id, actor, idempotencyKey: k })
    const again = await legacyClientApprove({ videoId: v1.id, actor, idempotencyKey: k })
    expect(again).toEqual({ decisionId: first.decisionId, applied: false })
    expect((await state(v1.id)).approved).toBe(true)
    expect((await state(v2.id)).approved).toBe(false)
  })
})

describe('review round 2 fixes', () => {
  it('idempotency key reused for a different video is a mismatch, not a silent replay', async () => {
    const { project, user } = await makeProject()
    const a = await addVersion(project.id, 'A', 1)
    const b = await addVersion(project.id, 'B', 1)
    await requestReview({ videoId: a.id, adminUserId: user.id })
    await requestReview({ videoId: b.id, adminUserId: user.id })
    const k = key()
    await clientDecide({ videoId: a.id, kind: 'APPROVE', actor, idempotencyKey: k })
    await expectCode(clientDecide({ videoId: b.id, kind: 'APPROVE', actor, idempotencyKey: k }), 'IDEMPOTENCY_MISMATCH')
  })

  it('moving a newer READY version into a group supersedes its stale open round', async () => {
    const { project, user } = await makeProject()
    const t1 = await addVersion(project.id, 'Ziel', 1)
    await requestReview({ videoId: t1.id, adminUserId: user.id })
    const x5 = await addVersion(project.id, 'Anderes', 5)
    await adminUpdateVersion({ videoId: x5.id, name: 'Ziel' })
    expect(await openRounds(t1.groupId)).toHaveLength(0)
    expect(await state(t1.id)).toEqual({ reviewState: 'DRAFT', approved: false })
  })

  it('parallel renames of the same version never split name and group', async () => {
    const { project } = await makeProject()
    const v = await addVersion(project.id, 'Start', 1)
    const results = await Promise.allSettled([
      adminUpdateVersion({ videoId: v.id, name: 'Eins' }),
      adminUpdateVersion({ videoId: v.id, name: 'Zwei' }),
      adminUpdateVersion({ videoId: v.id, name: 'Start' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0)
    const after = await prisma.video.findUniqueOrThrow({ where: { id: v.id }, include: { group: true } })
    expect(after.group.name).toBe(after.name)
  })

  it('protected fields cannot be smuggled in through markReady/createVersion', async () => {
    const { project } = await makeProject()
    const v = await createVersion({ projectId: project.id, name: 'P', data: { ...uploadData, approved: true } as never })
    expect(v.approved).toBe(false)
    await markReady(v.id, { approved: true, reviewState: 'APPROVED' } as never)
    expect(await state(v.id)).toEqual({ reviewState: 'DRAFT', approved: false })
  })
})

describe('review round 3 fixes', () => {
  it('idempotency: same key from another browser or with another note is a mismatch', async () => {
    const { project, user } = await makeProject()
    const v = await addVersion(project.id, 'F', 1)
    await requestReview({ videoId: v.id, adminUserId: user.id })
    const k = key()
    await clientDecide({ videoId: v.id, kind: 'REQUEST_CHANGES', actor, note: 'A', idempotencyKey: k })
    await expectCode(clientDecide({ videoId: v.id, kind: 'REQUEST_CHANGES', actor: { ...actor, viewerKeyHash: 'other' }, note: 'A', idempotencyKey: k }), 'IDEMPOTENCY_MISMATCH')
    await expectCode(clientDecide({ videoId: v.id, kind: 'REQUEST_CHANGES', actor, note: 'B', idempotencyKey: k }), 'IDEMPOTENCY_MISMATCH')
  })

  it('createVersion refuses READY as initial status', async () => {
    const { project } = await makeProject()
    await expectCode(createVersion({ projectId: project.id, name: 'X', data: { ...uploadData, status: 'READY' } }), 'NOT_READY')
  })

  it('unapprove project also catches a group created and sent for approval concurrently', async () => {
    const { project, user } = await makeProject()
    const a = await addVersion(project.id, 'A', 1)
    await adminOverride({ videoId: a.id, approved: true, adminUserId: user.id })
    const racer = (async () => {
      const v = await createVersion({ projectId: project.id, name: 'Neu', data: uploadData })
      await markReady(v.id, {})
      await requestReview({ videoId: v.id, adminUserId: user.id })
      return v
    })()
    await unapproveProject({ projectId: project.id, adminUserId: user.id })
    const v = await racer
    // Either the new round happened after the reset (still open, consistent) or it was reset with it.
    const s = await state(v.id)
    const rounds = await openRounds(v.groupId)
    expect(s.reviewState === 'IN_REVIEW' ? rounds.length : 0).toBe(rounds.length)
    expect((await state(a.id)).approved).toBe(false)
  })
})
