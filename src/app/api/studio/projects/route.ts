import { NextRequest, NextResponse } from 'next/server'
import { adminGuard } from '@/lib/admin-route'
import { projectSummaries } from '@/lib/studio'
import { prisma } from '@/lib/db'
import { generateVideoAccessToken } from '@/lib/video-access'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/studio/projects – overview rows for all projects + folders (admin)
export async function GET(request: NextRequest) {
  const admin = await adminGuard(request, 'studio-projects', 120, false)
  if (admin instanceof Response) return admin
  try {
    const [projects, folders] = await Promise.all([
      projectSummaries(admin.id),
      prisma.folder.findMany({ select: { id: true, name: true, parentId: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ])
    const sessionId = `studio:${admin.id}`
    const withThumbs = await Promise.all(projects.map(async (p) => {
      if (!p.thumbnailVideoId) return { ...p, thumbnailUrl: null }
      try {
        const token = await generateVideoAccessToken(p.thumbnailVideoId, p.id, 'thumbnail', request, sessionId)
        return { ...p, thumbnailUrl: `/api/content/${token}` }
      } catch {
        return { ...p, thumbnailUrl: null }
      }
    }))
    return NextResponse.json({ projects: withThumbs, folders })
  } catch (error) {
    logError('[STUDIO] overview failed:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
