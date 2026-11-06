import { NextRequest, NextResponse } from 'next/server'
import { adminGuard, folderErrorResponse } from '@/lib/admin-route'
import { undoMoveBatch } from '@/lib/folders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/folders/batches/:id/undo – revert a move batch where still possible (admin)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'folders-move')
  if (admin instanceof Response) return admin
  try {
    return NextResponse.json(await undoMoveBatch((await params).id))
  } catch (e) {
    return folderErrorResponse(e, 'FOLDERS-UNDO')
  }
}
