import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { createFolder } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const body = z.object({ name: z.string().max(200), parentId: z.string().min(1).max(64).nullable().optional() })

// POST /api/folders { name, parentId? } – new studio folder, optionally inside another (admin)
export async function POST(request: NextRequest) {
  const admin = await adminGuard(request, 'folders-write')
  if (admin instanceof Response) return admin
  const parsed = body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  try {
    return NextResponse.json({ folder: await createFolder(parsed.data.name, parsed.data.parentId ?? null) }, { status: 201 })
  } catch (e) {
    return folderErrorResponse(e, 'FOLDERS')
  }
}
