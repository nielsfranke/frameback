import { NextRequest, NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/same-origin'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { ReviewError, requestReview, withdrawReview } from '@/lib/review'
import { logError, logMessage } from '@/lib/logging'
import { notifyClientsReviewRequested } from '@/lib/review-notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function reviewErrorResponse(error: unknown) {
  if (error instanceof ReviewError) {
    const status = error.code === 'VIDEO_NOT_FOUND' ? 404 : 409
    return NextResponse.json({ error: error.message, code: error.code }, { status })
  }
  return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
}

// POST /api/videos/[id]/review-request – "Zur Freigabe senden" (admin)
// Body: { versionNote?: string }  ("Neu in Version 3: …", shown to the client)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin
  const admin = await requireApiAdmin(request)
  if (admin instanceof Response) return admin
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' }, 'review-request')
  if (limited) return limited
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const versionNote = typeof body?.versionNote === 'string' ? body.versionNote : undefined
  const notifyClients = body?.notifyClients !== false // default: inform the client by email
  try {
    const round = await requestReview({
      videoId: id,
      adminUserId: admin.id,
      actorName: admin.name || admin.email,
      versionNote,
    })
    logMessage(`[REVIEW] Version ${id} sent for approval by ${admin.email}`)
    // "Bitte prüfen" email to the project recipients (fire and forget; never blocks the action)
    if (notifyClients) {
      void notifyClientsReviewRequested(id).catch((e) => logError('[REVIEW] client notification failed:', e))
    }
    return NextResponse.json({ success: true, requestId: round.id, notifyClients })
  } catch (error) {
    return reviewErrorResponse(error)
  }
}

// DELETE /api/videos/[id]/review-request – "Zurückziehen" (admin)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin
  const admin = await requireApiAdmin(request)
  if (admin instanceof Response) return admin
  const { id } = await params
  try {
    await withdrawReview({ videoId: id, adminUserId: admin.id, actorName: admin.name || admin.email })
    return NextResponse.json({ success: true })
  } catch (error) {
    return reviewErrorResponse(error)
  }
}
