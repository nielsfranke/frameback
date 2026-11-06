/**
 * Frameback: edit, soft-delete and restore comments (docs/redesign/PLAN.md §3.4).
 *
 * Who may change a comment (deliberately simple – no codes, no accounts):
 *  - an admin: any comment
 *  - a client (share access with 'comment' permission to the comment's project):
 *    client comments written in this browser (vt_viewer key) OR carrying the same name.
 *    The name makes editing work across devices (PC today, phone tomorrow). Without
 *    accounts a name is no proof of identity – but anyone with the link could already
 *    post under any name; the safety net is: studio comments are never editable by
 *    clients, every edit keeps the previous text (CommentRevision), deletes are soft
 *    and restorable, edits are marked.
 * Deleting is always a soft delete. A deleted comment with studio replies remains as a
 * placeholder (see applySoftDelete); the author or an admin can restore it.
 */
import { prisma } from './db'
import { cancelCommentNotification, sanitizeAndValidateContent } from './comment-helpers'

export type CommentActor =
  | { kind: 'admin'; userId: string }
  | { kind: 'client'; viewerKeyHash: string | null; name?: string | null }

export class CommentMutationError extends Error {
  constructor(public code: 'NOT_FOUND' | 'FORBIDDEN' | 'DELETED' | 'NOT_DELETED' | 'INVALID', message: string, public status = 400) {
    super(message)
    this.name = 'CommentMutationError'
  }
}

/** Ownership as a write filter, so the check holds at the moment of writing. */
/** Names are compared trimmed, whitespace-collapsed and case-insensitive. */
export const normalizeName = (name?: string | null) => (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)

/**
 * Ownership as a write filter. `storedName` is the comment's own authorName after
 * loadOwned() verified it matches the actor's name (same normalization as ownsComment),
 * so SQL and JS can never disagree about whitespace.
 */
const ownerFilter = (actor: CommentActor, storedName?: string | null) => {
  if (actor.kind === 'admin') return {}
  const or: Array<Record<string, unknown>> = [{ authorKeyHash: actor.viewerKeyHash ?? '__none__' }]
  if (storedName && ownsComment({ name: actor.name }, { authorName: storedName })) or.push({ authorName: storedName })
  // never studio comments: neither marked internal nor written by a studio user
  return { isInternal: false, userId: null, OR: or }
}

export function ownsComment(
  actor: { viewerKeyHash?: string | null; name?: string | null },
  c: { isInternal?: boolean; userId?: string | null; authorKeyHash?: string | null; authorName?: string | null }
) {
  if (c.isInternal || c.userId) return false
  if (actor.viewerKeyHash && c.authorKeyHash === actor.viewerKeyHash) return true
  const name = normalizeName(actor.name)
  return !!name && normalizeName(c.authorName).toLowerCase() === name.toLowerCase()
}

async function loadOwned(commentId: string, actor: CommentActor, projectId?: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, projectId: true, isInternal: true, userId: true, authorKeyHash: true, authorName: true, deletedAt: true, deletedBy: true },
  })
  // Same answer for "missing" and "other project": no probing of comment ids across shares.
  if (!comment || (projectId && comment.projectId !== projectId)) {
    throw new CommentMutationError('NOT_FOUND', 'Comment not found', 404)
  }
  if (actor.kind === 'client') {
    const own = ownsComment(actor, comment)
    if (!own) throw new CommentMutationError('FORBIDDEN', 'You can only change your own comments', 403)
  }
  return comment
}

export async function editComment(params: { commentId: string; content: string; actor: CommentActor; projectId?: string }) {
  const comment = await loadOwned(params.commentId, params.actor, params.projectId)
  if (comment.deletedAt) throw new CommentMutationError('DELETED', 'Comment was deleted', 409)
  if (!params.content?.trim()) throw new CommentMutationError('INVALID', 'Comment must not be empty')
  const validated = await sanitizeAndValidateContent({ content: params.content })
  if (!validated.valid) throw new CommentMutationError('INVALID', validated.error || 'Invalid content', validated.errorStatus || 400)
  // Conditional write (still not deleted, still owned) and the previous text kept, atomically
  await prisma.$transaction(async (tx) => {
    // Lock the row first: concurrent edits then serialize and every replaced text is archived
    await tx.$queryRaw`SELECT "id" FROM "Comment" WHERE "id" = ${comment.id} FOR UPDATE`
    const before = await tx.comment.findUnique({ where: { id: comment.id }, select: { content: true } })
    const res = await tx.comment.updateMany({
      where: { id: comment.id, deletedAt: null, ...ownerFilter(params.actor, comment.authorName) },
      data: { content: validated.sanitizedContent!, editedAt: new Date() },
    })
    if (res.count !== 1 || !before) throw new CommentMutationError('DELETED', 'Comment was deleted or changed meanwhile', 409)
    if (before.content !== validated.sanitizedContent) {
      await tx.commentRevision.create({
        data: {
          commentId: comment.id,
          content: before.content,
          editedBy: params.actor.kind === 'admin' ? params.actor.userId : 'client',
          editorName: params.actor.kind === 'client' ? normalizeName(params.actor.name) || null : null,
        },
      })
    }
  })
  return prisma.comment.findUniqueOrThrow({ where: { id: comment.id }, select: { id: true, content: true, editedAt: true } })
}

export async function softDeleteComment(params: { commentId: string; actor: CommentActor; projectId?: string }) {
  const comment = await loadOwned(params.commentId, params.actor, params.projectId)
  const res = await prisma.comment.updateMany({
    where: { id: comment.id, deletedAt: null, ...ownerFilter(params.actor, comment.authorName) },
    data: { deletedAt: new Date(), deletedBy: params.actor.kind === 'admin' ? params.actor.userId : 'client' },
  })
  // Always (also on a repeated delete): a pending "new comment" email must not go out.
  // The email paths additionally check deletedAt, so a lost Redis flag cannot leak it.
  await cancelCommentNotification(comment.id)
  return { id: comment.id, alreadyDeleted: res.count === 0 }
}

export async function restoreComment(params: { commentId: string; actor: CommentActor; projectId?: string }) {
  const comment = await loadOwned(params.commentId, params.actor, params.projectId)
  if (!comment.deletedAt) throw new CommentMutationError('NOT_DELETED', 'Comment is not deleted', 409)
  // A deletion by the studio (moderation) can only be undone by an admin
  if (params.actor.kind === 'client' && comment.deletedBy !== 'client') {
    throw new CommentMutationError('FORBIDDEN', 'This comment was removed by the studio', 403)
  }
  const res = await prisma.comment.updateMany({
    where: {
      id: comment.id,
      deletedAt: { not: null },
      ...ownerFilter(params.actor, comment.authorName),
      // Clients can only undo their OWN deletion, also at the moment of writing
      ...(params.actor.kind === 'client' ? { deletedBy: 'client' } : {}),
    },
    data: { deletedAt: null, deletedBy: null },
  })
  if (res.count !== 1) throw new CommentMutationError('NOT_DELETED', 'Comment is not deleted', 409)
  return { id: comment.id }
}
