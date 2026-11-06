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

async function loadOwned(commentId: string, actor: CommentActor, projectId?: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, projectId: true, isInternal: true, authorKeyHash: true, deletedAt: true },
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
  return prisma.comment.update({
    where: { id: comment.id },
    data: { content: validated.sanitizedContent!, editedAt: new Date() },
    select: { id: true, content: true, editedAt: true },
  })
}

export async function softDeleteComment(params: { commentId: string; actor: CommentActor; projectId?: string }) {
  const comment = await loadOwned(params.commentId, params.actor, params.projectId)
  if (comment.deletedAt) return { id: comment.id, alreadyDeleted: true }
  await prisma.comment.update({
    where: { id: comment.id },
    data: { deletedAt: new Date(), deletedBy: params.actor.kind === 'admin' ? params.actor.userId : 'client' },
  })
  // A pending "new comment" email must not announce a deleted comment
  await cancelCommentNotification(comment.id)
  return { id: comment.id, alreadyDeleted: false }
}

export async function restoreComment(params: { commentId: string; actor: CommentActor; projectId?: string }) {
  const comment = await loadOwned(params.commentId, params.actor, params.projectId)
  if (!comment.deletedAt) throw new CommentMutationError('NOT_DELETED', 'Comment is not deleted', 409)
  return prisma.comment.update({
    where: { id: comment.id },
    data: { deletedAt: null, deletedBy: null },
    select: { id: true },
  })
}
