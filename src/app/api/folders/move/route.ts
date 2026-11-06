import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { moveProjects, moveProjectsGrouped } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const id = z.string().min(1).max(64)
const single = z.object({
  projectIds: z.array(id).min(1).max(500),
  folderId: id.nullable(),
  newFolderName: z.string().max(200).optional(),
})
const grouped = z.object({
  groups: z.array(z.object({
    folderId: id.optional(),
    newFolderName: z.string().max(200).optional(),
    projectIds: z.array(id).min(1).max(500),
  }).refine((g) => !!g.folderId !== (g.newFolderName !== undefined), 'folderId or newFolderName')).min(1).max(200),
})

// POST /api/folders/move – move projects (undoable batch). Body: single target or { groups } (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'folders-move')
  if (admin instanceof Response) return admin
  const raw = await request.json().catch(() => null)
  try {
    const g = grouped.safeParse(raw)
    if (g.success) return NextResponse.json(await moveProjectsGrouped(g.data.groups, admin.id))
    const s = single.safeParse(raw)
    if (!s.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    return NextResponse.json(await moveProjects({ ...s.data, actorUserId: admin.id }))
  } catch (e) {
    return folderErrorResponse(e, 'FOLDERS-MOVE')
  }
}
