import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { restoreProjects } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(64), status: z.enum(['IN_REVIEW', 'APPROVED', 'SHARE_ONLY']).optional(), stamp: z.string().datetime().optional() })).min(1).max(500),
})

// POST /api/projects/restore { items: [{ id, status? }] } – un-archive, optionally to the earlier status (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'projects-archive')
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json(await restoreProjects(parsed.data.items))
  } catch (e) {
    return folderErrorResponse(e, 'PROJECTS-RESTORE')
  }
}
