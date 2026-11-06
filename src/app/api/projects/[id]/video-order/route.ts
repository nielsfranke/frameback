import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { rejectCrossOrigin } from '@/lib/same-origin'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  // Complete list of the project's video groups in the desired order
  groupIds: z.array(z.string().min(1).max(64)).min(1).max(500),
})

// PUT /api/projects/[id]/video-order – order of the videos as clients see them (admin)
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin
  const admin = await requireApiAdmin(request)
  if (admin instanceof Response) return admin
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 60, message: 'Too many requests.' }, 'video-order')
  if (limited) return limited

  const { id: projectId } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const { groupIds } = parsed.data
  if (new Set(groupIds).size !== groupIds.length) {
    return NextResponse.json({ error: 'Duplicate group id' }, { status: 400 })
  }

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.videoGroup.findMany({ where: { projectId }, select: { id: true } })
      const known = new Set(existing.map((g) => g.id))
      // The list must be exactly the project's groups: no foreign ids, none missing
      if (existing.length !== groupIds.length || groupIds.some((g) => !known.has(g))) {
        throw new OrderMismatch()
      }
      for (const [index, groupId] of groupIds.entries()) {
        await tx.videoGroup.update({ where: { id: groupId }, data: { sortOrder: index + 1 } })
      }
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof OrderMismatch) {
      return NextResponse.json({ error: 'Video list changed, reload and try again', code: 'ORDER_MISMATCH' }, { status: 409 })
    }
    logError('[VIDEO-ORDER] update failed:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

class OrderMismatch extends Error {}
