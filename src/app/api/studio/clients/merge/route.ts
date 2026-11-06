import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard } from '@/lib/admin-route'
import { ClientError, mergeClients } from '@/lib/clients'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ sourceId: z.string().min(1).max(64), targetId: z.string().min(1).max(64) })

// POST /api/studio/clients/merge { sourceId, targetId } – only on explicit request (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-clients-write', 30)
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    const r = await mergeClients(parsed.data.sourceId, parsed.data.targetId)
    logMessage(`[CLIENTS] ${admin.email} merged ${parsed.data.sourceId} into ${parsed.data.targetId}`)
    return NextResponse.json(r)
  } catch (e) {
    if (e instanceof ClientError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 400 })
    logError('[CLIENTS] merge failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
