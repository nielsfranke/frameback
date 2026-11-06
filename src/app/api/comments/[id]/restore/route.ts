import { NextRequest, NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { CommentMutationError, restoreComment } from '@/lib/comment-mutations'
import { resolveCommentActor } from '@/lib/comment-actor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/comments/[id]/restore - undo a soft delete (author via browser key, or admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' }, 'comments-restore')
  if (limited) return limited
  const { id } = await params
  const resolved = await resolveCommentActor(request, id)
  if (resolved instanceof NextResponse) return resolved
  try {
    await restoreComment({ commentId: id, ...resolved })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof CommentMutationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
