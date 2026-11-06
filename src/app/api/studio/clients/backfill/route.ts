import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard } from '@/lib/admin-route'
import { applyClientBackfill, planClientBackfill } from '@/lib/clients'
import { logError, logMessage } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/studio/clients/backfill – preview: which projects would get which client (read-only)
export async function GET(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-clients', 60, false)
  if (admin instanceof Response) return admin
  try {
    return NextResponse.json(await planClientBackfill())
  } catch (e) {
    logError('[CLIENTS] backfill plan failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

const body = z.object({ projectIds: z.array(z.string().min(1).max(64)).min(1).max(5000) })

// POST /api/studio/clients/backfill { projectIds } – apply exactly the previewed set (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-clients-write', 10)
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    const r = await applyClientBackfill(parsed.data.projectIds)
    logMessage(`[CLIENTS] backfill by ${admin.email}: ${r.linked} linked, ${r.clientsCreated} clients created, ${r.skipped} skipped`)
    return NextResponse.json({ linked: r.linked, skipped: r.skipped, clientsCreated: r.clientsCreated })
  } catch (e) {
    logError('[CLIENTS] backfill failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
