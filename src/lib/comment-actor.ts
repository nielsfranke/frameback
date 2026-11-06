import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { verifyProjectAccess } from '@/lib/project-access'
import { viewerHashFrom } from '@/lib/comment-ownership'
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
  if (!access.authorized) {
    return access.errorResponse || NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }
  return { actor: { kind: 'client', viewerKeyHash: viewerHashFrom(request) }, projectId: project.id }
}

