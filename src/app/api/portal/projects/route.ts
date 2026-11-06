import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { groupState } from '@/lib/studio-shared'
import { rateLimit } from '@/lib/rate-limit'
import { parseBearerToken } from '@/lib/auth'
import { verifyPortalSession } from '@/lib/portal-token'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    // Cheap network-layer guard against unauthenticated spammers before we touch JWT verify.
    const ipLimit = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 120,
      message: 'Too many requests. Please slow down.',
    }, 'portal-projects-ip')
    if (ipLimit) return ipLimit

    const bearer = parseBearerToken(request)
    if (!bearer) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const session = await verifyPortalSession(bearer)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-session quota — one stolen IP with N sessions can't pool quotas.
    const sessionLimit = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.',
    }, 'portal-projects-session', session.sessionId)
    if (sessionLimit) return sessionLimit

    const projects = await prisma.project.findMany({
      where: {
        status: { in: ['IN_REVIEW', 'APPROVED'] },
        recipients: {
          some: {
            email: { equals: session.email, mode: 'insensitive' },
          },
        },
      },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        dueDate: true,
        updatedAt: true,
        approvedAt: true,
      },
      orderBy: [
        { updatedAt: 'desc' },
      ],
    })

    // Frameback: real progress per project from the current version of each video
    const ready = await prisma.video.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, status: 'READY' },
      select: { projectId: true, groupId: true, reviewState: true, approved: true },
      orderBy: { version: 'desc' },
    })
    const seen = new Set<string>()
    const progress = new Map<string, { videos: number; approved: number; waiting: number; changes: number }>()
    for (const v of ready) {
      if (seen.has(v.groupId)) continue
      seen.add(v.groupId)
      const s = groupState(v)
      const cur = progress.get(v.projectId) ?? { videos: 0, approved: 0, waiting: 0, changes: 0 }
      cur.videos++
      if (s === 'approved') cur.approved++
      else if (s === 'waiting') cur.waiting++
      else if (s === 'changes') cur.changes++
      progress.set(v.projectId, cur)
    }

    // Sort: waiting for this client first, then most recent activity.
    const sorted = projects.slice().sort((a, b) => {
      const aNeeds = (progress.get(a.id)?.waiting ?? 0) > 0 ? 0 : 1
      const bNeeds = (progress.get(b.id)?.waiting ?? 0) > 0 ? 0 : 1
      if (aNeeds !== bNeeds) return aNeeds - bNeeds
      return b.updatedAt.getTime() - a.updatedAt.getTime()
    })

    return NextResponse.json({
      projects: sorted.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        status: p.status,
        dueDate: p.dueDate ? p.dueDate.toISOString() : null,
        lastActivityAt: p.updatedAt.toISOString(),
        ...(progress.get(p.id) ?? { videos: 0, approved: 0, waiting: 0, changes: 0 }),
      })),
    })
  } catch (error) {
    logError('[PORTAL] projects error:', error)
    return NextResponse.json({ error: 'Failed to load projects' }, { status: 500 })
  }
}
