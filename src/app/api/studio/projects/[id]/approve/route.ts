import { NextRequest, NextResponse } from 'next/server'
import { adminGuard } from '@/lib/admin-route'
import { prisma } from '@/lib/db'
import { approveProjectAsStudio, ReviewError } from '@/lib/review'
import { getCleanPreviewQueue } from '@/lib/queue'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/studio/projects/:id/approve – studio approves the current version of every video
// (client agreed outside the app). Recorded as studio override, no notifications (admin).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminGuard(request, 'studio-approve-project', 20)
  if (admin instanceof Response) return admin
  const { id } = await params
  try {
    const { approvedIds } = await approveProjectAsStudio({
      projectId: id,
      adminUserId: admin.id,
      actorName: admin.name || admin.email || 'Studio',
    })
    // same follow-up as a single approval: clean (unwatermarked) previews where configured.
    // Every approved version still missing one is queued, so a job lost earlier (queue down)
    // is made up for on the next approval in this project.
    const project = await prisma.project.findUnique({
      where: { id },
      select: { usePreviewForApprovedPlayback: true, watermarkEnabled: true, previewResolution: true },
    })
    if (project?.usePreviewForApprovedPlayback && project.watermarkEnabled) {
      const field = project.previewResolution === '2160p' ? 'cleanPreview2160Path'
        : project.previewResolution === '1080p' ? 'cleanPreview1080Path' : 'cleanPreview720Path'
      const videos = await prisma.video.findMany({
        where: { projectId: id, approved: true, status: 'READY', [field]: null },
        select: { id: true, originalStoragePath: true },
      })
      for (const v of videos) {
        try {
          await getCleanPreviewQueue().add('generate-clean-preview', {
            videoId: v.id, projectId: id, originalStoragePath: v.originalStoragePath, resolution: project.previewResolution,
          })
        } catch (e) {
          logError('[STUDIO] clean preview queue failed:', e)
        }
      }
    }
    return NextResponse.json({ approved: approvedIds.length })
  } catch (e) {
    if (e instanceof ReviewError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'PROJECT_NOT_FOUND' ? 404 : 409 })
    }
    logError('[STUDIO] approve project failed:', e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
