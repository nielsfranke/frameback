import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { setProjectsCompleted } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({
  /** stamp: from an earlier answer, for undo – only reverts projects unchanged since */
  items: z.array(z.object({ id: z.string().min(1).max(64), stamp: z.string().max(40).optional() })).min(1).max(500),
  completed: z.boolean(),
})

// POST /api/projects/complete { items: [{ id, stamp? }], completed } – "Abschließen" / "Wieder öffnen";
// returns the ids that changed plus stamps for undo (admin). The share link is not affected.
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'projects-complete')
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json(await setProjectsCompleted(parsed.data.items, parsed.data.completed))
  } catch (e) {
    return folderErrorResponse(e, 'PROJECTS-COMPLETE')
  }
}
