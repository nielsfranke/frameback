import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard } from '@/lib/admin-route'
import { keepSeparate } from '@/lib/clients'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ aId: z.string().min(1).max(64), bId: z.string().min(1).max(64) })

// POST /api/studio/clients/keep { aId, bId } – remember: not the same client (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-clients-write', 60)
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success || parsed.data.aId === parsed.data.bId) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    await keepSeparate(parsed.data.aId, parsed.data.bId)
    return NextResponse.json({ success: true })
  } catch (e) {
    logError('[CLIENTS] keep failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
