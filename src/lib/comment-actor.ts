import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { verifyProjectAccess } from '@/lib/project-access'
import { viewerHashFrom } from '@/lib/comment-ownership'
import { sanitizeAndValidateContent } from '@/lib/comment-helpers'
import type { CommentActor } from '@/lib/comment-mutations'

/**
 * Frameback: who is changing this comment?
 *  - admin session -> may change any comment
 *  - otherwise a client with share access ('comment' permission) to the comment's
 *    project; ownership is checked against the vt_viewer key in comment-mutations.
 */
export async function resolveCommentActor(
  request: NextRequest,
  commentId: string
): Promise<{ actor: CommentActor; projectId?: string } | NextResponse> {
  const user = await getCurrentUserFromRequest(request)
  if (user?.role === 'ADMIN') return { actor: { kind: 'admin', userId: user.id } }

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { project: { select: { id: true, sharePassword: true, authMode: true } } },
  })
  if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  const { project } = comment
  const access = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode, {
    allowGuest: false,
    requiredPermission: 'comment',
    requireVideoAccess: true,
  })
  // No share session at all: 401 so the page can ask for the password/code again.
  // Authenticated for another share, guest, or missing permission: answer like a missing
  // comment (404) – no probing of comment ids across shares.
  if (!access.authorized) {
    const status = access.errorResponse?.status
    return status === 401
      ? access.errorResponse!
      : NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }
  // The commenter's name (header, URI-encoded) enables editing own comments on any device.
  // It is sanitized like stored author names, so the comparison matches what is saved.
  let name: string | null = null
  try { name = decodeURIComponent(request.headers.get('x-commenter-name') ?? '') || null } catch { name = null }
  if (name) {
    const v = await sanitizeAndValidateContent({ content: '.', authorName: name.slice(0, 100) })
    name = v.valid ? v.sanitizedAuthorName ?? null : null
  }
  return { actor: { kind: 'client', viewerKeyHash: viewerHashFrom(request), name }, projectId: project.id }
}

