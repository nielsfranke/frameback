import { NextRequest, NextResponse } from 'next/server'
import { adminGuard } from '@/lib/admin-route'
import { clientList, duplicateSuggestions, planClientBackfill } from '@/lib/clients'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/studio/clients – directory rows, duplicate suggestions, pending backfill count (admin)
export async function GET(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-clients', 120, false)
  if (admin instanceof Response) return admin
  try {
    const [clients, duplicates, plan] = await Promise.all([clientList(admin.id), duplicateSuggestions(), planClientBackfill()])
    return NextResponse.json({ clients, duplicates, backfill: { projects: plan.items.length, ambiguous: plan.ambiguous.length } })
  } catch (e) {
    logError('[CLIENTS] list failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
