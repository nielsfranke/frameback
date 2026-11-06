import { NextRequest, NextResponse } from 'next/server'
import { adminGuard } from '@/lib/admin-route'
import { clientDetail, ClientError } from '@/lib/clients'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/studio/clients/:id – contacts with origin + recipients that could become contacts (admin)
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'studio-clients', 120, false)
  if (admin instanceof Response) return admin
  try {
    return NextResponse.json(await clientDetail((await params).id))
  } catch (e) {
    if (e instanceof ClientError) return NextResponse.json({ error: e.message }, { status: 404 })
    logError('[CLIENTS] detail failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
