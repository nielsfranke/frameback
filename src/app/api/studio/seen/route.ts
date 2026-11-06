import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard } from '@/lib/admin-route'
import { markSeen } from '@/lib/studio-feedback'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ commentIds: z.array(z.string().min(1).max(64)).min(1).max(500) })

// POST /api/studio/seen { commentIds } – the requesting studio user has seen these comments
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-seen', 240)
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json(await markSeen(admin.id, parsed.data.commentIds))
  } catch (e) {
    logError('[STUDIO] seen failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
