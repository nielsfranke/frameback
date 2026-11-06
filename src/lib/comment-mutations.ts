/**
 * Frameback: edit, soft-delete and restore comments (docs/redesign/PLAN.md §3.4).
 *
 * Who may change a comment:
 *  - an admin: any comment
 *  - a client: only own client comments, proven by the vt_viewer browser key
 *    (comment.authorKeyHash === sha256(key)); the route additionally requires share
 *    access to the project with the 'comment' permission.
 * Deleting is always a soft delete. A deleted comment with studio replies remains as a
 * placeholder (see applySoftDelete); the author or an admin can restore it.
 */
import { prisma } from './db'
import { cancelCommentNotification, sanitizeAndValidateContent } from './comment-helpers'

export type CommentActor =
  | { kind: 'admin'; userId: string }
  | { kind: 'client'; viewerKeyHash: string | null }

export class CommentMutationError extends Error {
  constructor(public code: 'NOT_FOUND' | 'FORBIDDEN' | 'DELETED' | 'NOT_DELETED' | 'INVALID', message: string, public status = 400) {
    super(message)
    this.name = 'CommentMutationError'
  }
}

/** Ownership as a write filter, so the check holds at the moment of writing. */
const ownerFilter = (actor: CommentActor) =>
  actor.kind === 'admin' ? {} : { isInternal: false, authorKeyHash: actor.viewerKeyHash ?? '__none__' }

async function loadOwned(commentId: string, actor: CommentActor, projectId?: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, projectId: true, isInternal: true, authorKeyHash: true, deletedAt: true, deletedBy: true },
  })
  // Same answer for "missing" and "other project": no probing of comment ids across shares.
  if (!comment || (projectId && comment.projectId !== projectId)) {
    throw new CommentMutationError('NOT_FOUND', 'Comment not found', 404)
  }
  if (actor.kind === 'client') {
    const own = !comment.isInternal && !!actor.viewerKeyHash && comment.authorKeyHash === actor.viewerKeyHash
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
  // Conditional write: still not deleted and still owned (no check-then-write race)
  const res = await prisma.comment.updateMany({
    where: { id: comment.id, deletedAt: null, ...ownerFilter(params.actor) },
    data: { content: validated.sanitizedContent!, editedAt: new Date() },
  })
  if (res.count !== 1) throw new CommentMutationError('DELETED', 'Comment was deleted or changed meanwhile', 409)
  return prisma.comment.findUniqueOrThrow({ where: { id: comment.id }, select: { id: true, content: true, editedAt: true } })
}

export async function softDeleteComment(params: { commentId: string; actor: CommentActor; projectId?: string }) {
  const comment = await loadOwned(params.commentId, params.actor, params.projectId)
  const res = await prisma.comment.updateMany({
    where: { id: comment.id, deletedAt: null, ...ownerFilter(params.actor) },
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
    where: { id: comment.id, deletedAt: { not: null }, ...ownerFilter(params.actor) },
    data: { deletedAt: null, deletedBy: null },
  })
  if (res.count !== 1) throw new CommentMutationError('NOT_DELETED', 'Comment is not deleted', 409)
  return { id: comment.id }
}
