import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { archiveProjects } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ projectIds: z.array(z.string().min(1).max(64)).min(1).max(500) })

// POST /api/projects/archive { projectIds } – returns previous statuses for undo (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'projects-archive')
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json(await archiveProjects(parsed.data.projectIds))
  } catch (e) {
    return folderErrorResponse(e, 'PROJECTS-ARCHIVE')
  }
}
