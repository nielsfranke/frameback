import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard } from '@/lib/admin-route'
import { FeedbackError, setResolved } from '@/lib/studio-feedback'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ resolved: z.boolean() })

// POST /api/studio/comments/:id/resolve { resolved } – studio marks a thread done / reopens it
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'studio-resolve', 120)
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json(await setResolved((await params).id, admin.id, parsed.data.resolved))
  } catch (e) {
    if (e instanceof FeedbackError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 400 })
    logError('[STUDIO] resolve failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
