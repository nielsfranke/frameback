/**
 * Frameback studio feedback: mark client comments done/reopen, read state per studio
 * user, and the project activity feed ("Verlauf").
 */
import { Prisma } from '@prisma/client'
import { prisma } from './db'
import { CLIENT_FEEDBACK_SQL } from './studio'

export class FeedbackError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID', message: string) { super(message) }
}

/** Studio marks a comment thread done (or reopens it). Only top-level, not deleted. */
export async function setResolved(commentId: string, userId: string, resolved: boolean) {
  const c = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true, parentId: true, deletedAt: true } })
  if (!c || c.deletedAt) throw new FeedbackError('NOT_FOUND', 'Comment not found')
  if (c.parentId) throw new FeedbackError('INVALID', 'Only threads can be marked done')
  return prisma.comment.update({
    where: { id: commentId },
    data: resolved
      ? { resolvedAt: new Date(), resolvedById: userId, resolvedVia: 'STUDIO' }
      : { resolvedAt: null, resolvedById: null, resolvedVia: null },
    select: { id: true, resolvedAt: true, resolvedVia: true },
  })
}

/** Record that the user has seen these comments; unknown ids are ignored. */
export async function markSeen(userId: string, commentIds: string[]) {
  const ids = [...new Set(commentIds)].slice(0, 500)
  if (!ids.length) return { marked: 0 }
  const existing = await prisma.comment.findMany({ where: { id: { in: ids } }, select: { id: true } })
  const res = await prisma.studioCommentSeen.createMany({
    data: existing.map((c) => ({ userId, commentId: c.id })),
    skipDuplicates: true,
  })
  return { marked: res.count }
}

/** Ids of client comments in a project the user has not seen yet (same rule as the overview). */
export async function unreadCommentIds(userId: string, projectId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Comment" c JOIN "User" u ON u.id = ${userId}
     WHERE c."projectId" = ${projectId} AND ${CLIENT_FEEDBACK_SQL}
       AND c."createdAt" > u."feedbackSeenBaseline"
       AND NOT EXISTS (SELECT 1 FROM "StudioCommentSeen" s WHERE s."userId" = ${userId} AND s."commentId" = c.id)`
  return rows.map((r) => r.id)
}

export type ActivityItem =
  | { type: 'decision'; at: string; kind: string; actor: string; video: string; version: number }
  | { type: 'upload'; at: string; video: string; version: number }
  | { type: 'comments'; at: string; actor: string; video: string; count: number }

/** Latest events of a project, newest first. Client comments are grouped per author+video+day. */
export async function projectActivity(projectId: string, limit = 12): Promise<ActivityItem[]> {
  const [decisions, uploads, comments] = await Promise.all([
    prisma.reviewDecision.findMany({
      where: { video: { projectId } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { createdAt: true, kind: true, actorName: true, video: { select: { name: true, version: true } } },
    }),
    prisma.video.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { createdAt: true, name: true, version: true },
    }),
    prisma.$queryRaw<Array<{ at: Date; actor: string | null; video: string; n: bigint }>>`
      SELECT max(c."createdAt") AS at, c."authorName" AS actor, v.name AS video, count(*)::bigint AS n
        FROM "Comment" c JOIN "Video" v ON v.id = c."videoId"
       WHERE c."projectId" = ${projectId} AND ${CLIENT_FEEDBACK_SQL}
       GROUP BY c."authorName", v.name, date_trunc('day', c."createdAt")
       ORDER BY at DESC LIMIT ${Prisma.raw(String(limit))}`,
  ])
  const items: ActivityItem[] = [
    ...decisions.map((d) => ({ type: 'decision' as const, at: d.createdAt.toISOString(), kind: d.kind, actor: d.actorName, video: d.video.name, version: d.video.version })),
    ...uploads.map((u) => ({ type: 'upload' as const, at: u.createdAt.toISOString(), video: u.name, version: u.version })),
    ...comments.map((c) => ({ type: 'comments' as const, at: c.at.toISOString(), actor: c.actor || '', video: c.video, count: Number(c.n) })),
  ]
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}
