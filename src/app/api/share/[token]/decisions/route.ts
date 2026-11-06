import { NextRequest, NextResponse } from 'next/server'
import { rejectCrossOrigin } from '@/lib/same-origin'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { verifyProjectAccess } from '@/lib/project-access'
import { viewerHashFrom } from '@/lib/comment-ownership'
import { ReviewError, clientDecide, idempotencyKeyFrom } from '@/lib/review'
import { getClientIpAddress } from '@/lib/utils'
import { enqueueExternalNotification } from '@/lib/external-notifications/enqueueExternalNotification'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  videoId: z.string().min(1),
  kind: z.literal('REQUEST_CHANGES'), // approvals keep using POST /api/projects/:id/approve
  authorName: z.string().trim().max(100).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  commentIds: z.array(z.string().min(1)).max(200).optional(),
})

/**
 * POST /api/share/[token]/decisions – client decision on the current version.
 * Currently: "Änderungen anfordern" (closes the open round, hands over the client's
 * comments with a text snapshot, notifies the studio). Requires an open round for
 * exactly this version (see src/lib/review.ts).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 20, message: 'Too many requests.' }, 'share-decisions')
  if (limited) return limited

  const { token } = await params
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })
  const input = parsed.data

  const project = await prisma.project.findUnique({
    where: { slug: token },
    select: { id: true, title: true, sharePassword: true, authMode: true, clientCanApprove: true },
  })
  // Same answer as an unknown link: no enumeration of share slugs
  if (!project) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const access = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode, {
    allowGuest: false,
    requiredAnyPermission: ['approve', 'comment'],
    requireVideoAccess: true,
  })
  if (!access.authorized) return access.errorResponse || NextResponse.json({ error: 'Access denied' }, { status: 403 })
  if (!access.isAdmin && project.clientCanApprove === false) {
    return NextResponse.json({ error: 'Decisions are made by the studio for this project' }, { status: 403 })
  }

  const video = await prisma.video.findUnique({ where: { id: input.videoId }, select: { projectId: true, name: true, versionLabel: true } })
  if (!video || video.projectId !== project.id) return NextResponse.json({ error: 'Video not found' }, { status: 404 })

  try {
    const result = await clientDecide({
      videoId: input.videoId,
      kind: input.kind,
      actor: {
        name: input.authorName || 'Client', // unverified display name
        viewerKeyHash: viewerHashFrom(request),
        ip: getClientIpAddress(request),
      },
      note: input.note ?? null,
      commentIds: input.commentIds,
      idempotencyKey: idempotencyKeyFrom(request.headers.get('idempotency-key')),
    })

    if (result.applied) {
      const body = `${input.authorName || 'Client'} requested changes\nProject: ${project.title}\nVideo: ${video.name} ${video.versionLabel}` +
        (input.note ? `\n\n${input.note}` : '') + (input.commentIds?.length ? `\n${input.commentIds.length} comments handed over` : '')
      void enqueueExternalNotification({
        eventType: 'VIDEO_APPROVAL',
        title: 'Änderungen angefordert',
        body,
        notifyType: 'warning',
        pushData: { projectTitle: project.title, projectId: project.id, videoName: video.name, title: 'Änderungen angefordert', body },
      }).catch((e) => logError('[DECISIONS] notification failed:', e))
    }
    return NextResponse.json({ success: true, replayed: !result.applied })
  } catch (error) {
    if (error instanceof ReviewError) {
      const status = error.code === 'INVALID_IDEMPOTENCY_KEY' || error.code === 'INVALID_COMMENTS' ? 400 : 409
      return NextResponse.json({ error: error.message, code: error.code }, { status })
    }
    logError('[DECISIONS] failed:', error)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}
