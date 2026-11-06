import { NextRequest, NextResponse } from 'next/server'
import { adminGuard } from '@/lib/admin-route'
import { projectActivity, unreadCommentIds } from '@/lib/studio-feedback'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/studio/projects/:id/feedback – unread comment ids for this user + activity feed
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'studio-feedback', 240, false)
  if (admin instanceof Response) return admin
  const { id } = await params
  try {
    const [unreadIds, activity] = await Promise.all([unreadCommentIds(admin.id, id), projectActivity(id)])
    return NextResponse.json({ unreadIds, activity })
  } catch (e) {
    logError('[STUDIO] feedback failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
