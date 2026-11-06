import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { resolveCommentActor } from '@/lib/comment-actor'
import { CommentMutationError, editComment, softDeleteComment } from '@/lib/comment-mutations'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'

export const runtime = 'nodejs'

// Prevent static generation for this route
export const dynamic = 'force-dynamic'

async function limited(request: NextRequest, key: string) {
  const messages = await loadLocaleMessages(await getConfiguredLocale().catch(() => 'en')).catch(() => null)
  return rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: messages?.share?.tooManyRequestsGeneric || 'Too many requests. Please slow down.',
  }, key)
}

function mutationError(error: unknown) {
  if (error instanceof CommentMutationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  }
  return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
}

// PATCH /api/comments/[id] - edit own comment (client) or any comment (admin)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limitedResponse = await limited(request, 'comments-edit')
  if (limitedResponse) return limitedResponse
  const { id } = await params
  const resolved = await resolveCommentActor(request, id)
  if (resolved instanceof NextResponse) return resolved
  const body = await request.json().catch(() => null)
  if (!body || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }
  try {
    const updated = await editComment({ commentId: id, content: body.content, ...resolved })
    return NextResponse.json({ success: true, comment: updated })
  } catch (error) {
    return mutationError(error)
  }
}

// DELETE /api/comments/[id] - soft delete own comment (client) or any comment (admin)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limitedResponse = await limited(request, 'comments-delete')
  if (limitedResponse) return limitedResponse
  const { id } = await params
  const resolved = await resolveCommentActor(request, id)
  if (resolved instanceof NextResponse) return resolved
  try {
    const result = await softDeleteComment({ commentId: id, ...resolved })
    // Return success - client will refresh to get updated comments
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    return mutationError(error)
  }
}
