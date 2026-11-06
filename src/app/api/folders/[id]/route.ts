import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { deleteFolder, renameFolder } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ name: z.string().max(200) })

// PATCH /api/folders/:id { name } – rename (admin)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'folders-write')
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json({ folder: await renameFolder((await params).id, parsed.data.name) })
  } catch (e) {
    return folderErrorResponse(e, 'FOLDERS')
  }
}

// DELETE /api/folders/:id – projects inside move to "no folder" (admin)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'folders-write')
  if (admin instanceof Response) return admin
  try {
    return NextResponse.json(await deleteFolder((await params).id))
  } catch (e) {
    return folderErrorResponse(e, 'FOLDERS')
  }
}
