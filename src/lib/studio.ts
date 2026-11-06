/**
 * Frameback studio overview: one summary row per project.
 *
 * Small-studio scale (tens to a few hundred projects): everything is loaded in a
 * handful of set-based queries and filtered client-side, so view counts in the
 * sidebar and the list always agree.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './db'

import { groupState } from './studio-shared'
export { groupState, type GroupState } from './studio-shared'

export interface ProjectSummary {
  id: string
  title: string
  slug: string
  status: string
  archived: boolean
  createdAt: string
  dueDate: string | null
  client: { id: string; name: string } | null
  /** Free-text company name, shown when no client record is linked */
  companyName: string | null
  folder: { id: string; name: string } | null
  /** Video groups (one per video, all versions) */
  videos: number
  approved: number
  waiting: number
  changes: number
  /** Unread client comments for the requesting studio user */
  unread: number
  thumbnailVideoId: string | null
  last: LastActivity | null
}

export type LastActivity =
  | { type: 'comment'; at: string; actor: string; count: number }
  | { type: 'decision'; at: string; actor: string; kind: string }
  | { type: 'upload'; at: string; video: string; version: number }
  | { type: 'created'; at: string }

/** Client-authored, not deleted: the only comments that count as feedback */
export const CLIENT_FEEDBACK_SQL = Prisma.sql`c."deletedAt" IS NULL AND c."isInternal" = false AND c."userId" IS NULL`

export async function unreadByProject(userId: string, projectIds: string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ projectId: string; n: bigint }>>`
    SELECT c."projectId", count(*)::bigint AS n
      FROM "Comment" c
      JOIN "User" u ON u.id = ${userId}
     WHERE c."projectId" IN (${Prisma.join(projectIds)})
       AND ${CLIENT_FEEDBACK_SQL}
       AND c."createdAt" > u."feedbackSeenBaseline"
       AND NOT EXISTS (SELECT 1 FROM "StudioCommentSeen" s WHERE s."userId" = ${userId} AND s."commentId" = c.id)
     GROUP BY c."projectId"`
  return new Map(rows.map((r) => [r.projectId, Number(r.n)]))
}

async function lastActivity(projectIds: string[]): Promise<Map<string, LastActivity>> {
  const out = new Map<string, LastActivity>()
  if (projectIds.length === 0) return out
  const ids = Prisma.join(projectIds)
  const [comments, decisions, uploads] = await Promise.all([
    // newest client comment, plus how many the same author wrote within the hour before it
    prisma.$queryRaw<Array<{ projectId: string; at: Date; actor: string | null; n: bigint }>>`
      SELECT DISTINCT ON (c."projectId") c."projectId", c."createdAt" AS at, c."authorName" AS actor,
             (SELECT count(*) FROM "Comment" c2
               WHERE c2."projectId" = c."projectId" AND c2."deletedAt" IS NULL AND c2."isInternal" = false
                 AND c2."userId" IS NULL AND c2."authorName" IS NOT DISTINCT FROM c."authorName"
                 AND c2."createdAt" > c."createdAt" - interval '1 hour')::bigint AS n
        FROM "Comment" c
       WHERE c."projectId" IN (${ids}) AND ${CLIENT_FEEDBACK_SQL}
       ORDER BY c."projectId", c."createdAt" DESC`,
    prisma.$queryRaw<Array<{ projectId: string; at: Date; actor: string; kind: string }>>`
      SELECT DISTINCT ON (v."projectId") v."projectId", d."createdAt" AS at, d."actorName" AS actor, d.kind::text AS kind
        FROM "ReviewDecision" d JOIN "Video" v ON v.id = d."videoId"
       WHERE v."projectId" IN (${ids})
       ORDER BY v."projectId", d."createdAt" DESC`,
    prisma.$queryRaw<Array<{ projectId: string; at: Date; video: string; version: number }>>`
      SELECT DISTINCT ON (v."projectId") v."projectId", v."createdAt" AS at, v.name AS video, v.version
        FROM "Video" v
       WHERE v."projectId" IN (${ids})
       ORDER BY v."projectId", v."createdAt" DESC`,
  ])
  const consider = (pid: string, a: LastActivity) => {
    const cur = out.get(pid)
    if (!cur || new Date(a.at) > new Date(cur.at)) out.set(pid, a)
  }
  for (const r of comments) consider(r.projectId, { type: 'comment', at: r.at.toISOString(), actor: r.actor || '', count: Number(r.n) })
  for (const r of decisions) consider(r.projectId, { type: 'decision', at: r.at.toISOString(), actor: r.actor, kind: r.kind })
  for (const r of uploads) consider(r.projectId, { type: 'upload', at: r.at.toISOString(), video: r.video, version: r.version })
  return out
}

export async function projectSummaries(userId: string): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    select: {
      id: true, title: true, slug: true, status: true, createdAt: true, dueDate: true, companyName: true,
      clientCompany: { select: { id: true, name: true } },
      folder: { select: { id: true, name: true } },
    },
  })
  const projectIds = projects.map((p) => p.id)
  const [videos, unread, last] = await Promise.all([
    prisma.video.findMany({
      where: { projectId: { in: projectIds }, status: 'READY' },
      select: {
        id: true, projectId: true, groupId: true, version: true, reviewState: true, approved: true, thumbnailPath: true,
        group: { select: { sortOrder: true, name: true } },
      },
      orderBy: { version: 'desc' },
    }),
    unreadByProject(userId, projectIds),
    lastActivity(projectIds),
  ])

  // current version per group (videos are ordered newest version first)
  const current = new Map<string, (typeof videos)[number]>()
  for (const v of videos) if (!current.has(v.groupId)) current.set(v.groupId, v)
  const byProject = new Map<string, Array<(typeof videos)[number]>>()
  for (const v of current.values()) {
    const list = byProject.get(v.projectId) ?? []
    list.push(v)
    byProject.set(v.projectId, list)
  }
  // sortOrder 0 = not positioned yet (video-order assigns 1..n): goes last, like in the share view
  const position = (v: (typeof videos)[number]) => v.group?.sortOrder || Number.MAX_SAFE_INTEGER

  return projects.map((p) => {
    const groups = (byProject.get(p.id) ?? []).sort(
      (a, b) => position(a) - position(b) || (a.group?.name ?? '').localeCompare(b.group?.name ?? '', undefined, { numeric: true }),
    )
    const states = groups.map(groupState)
    const thumb = groups.find((g) => g.thumbnailPath)
    return {
      id: p.id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      archived: p.status === 'ARCHIVED',
      createdAt: p.createdAt.toISOString(),
      dueDate: p.dueDate ? p.dueDate.toISOString() : null,
      client: p.clientCompany,
      companyName: p.companyName,
      folder: p.folder,
      videos: groups.length,
      approved: states.filter((s) => s === 'approved').length,
      waiting: states.filter((s) => s === 'waiting').length,
      changes: states.filter((s) => s === 'changes').length,
      unread: unread.get(p.id) ?? 0,
      thumbnailVideoId: thumb?.id ?? null,
      last: last.get(p.id) ?? { type: 'created', at: p.createdAt.toISOString() },
    }
  })
}
