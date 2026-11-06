import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard } from '@/lib/admin-route'
import { FrameError, thumbnailFromFrame } from '@/lib/frame-thumbnail'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ seconds: z.number().min(0).max(24 * 3600) })

// POST /api/videos/:id/thumbnail { seconds } – frame at the player position becomes the thumbnail (admin only)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // ffmpeg work: a tight limit per admin
  const admin = await adminGuard(request, 'video-frame-thumbnail', 12)
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    const { id } = await params
    const r = await thumbnailFromFrame({ videoId: id, seconds: parsed.data.seconds, userId: admin.id, userName: admin.name || admin.email })
    logMessage(`[THUMBNAIL] ${admin.email} set frame ${r.seconds.toFixed(2)}s of ${id} as thumbnail`)
    return NextResponse.json(r)
  } catch (e) {
    if (e instanceof FrameError) {
      if (e.code === 'FAILED') logError('[THUMBNAIL] frame grab failed:', e.message)
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'NOT_READY' ? 409 : 500
      return NextResponse.json({ error: e.code === 'FAILED' ? 'Frame grab failed' : e.message, code: e.code }, { status })
    }
    logError('[THUMBNAIL] failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
