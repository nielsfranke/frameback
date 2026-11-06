import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ReviewError, adminOverride, clientDecide, idempotencyKeyFrom, legacyClientApprove } from '@/lib/review'
import { getCurrentUserFromRequest } from '@/lib/auth'
import { features } from '@/lib/features'
import { getClientIpAddress } from '@/lib/utils'
import { handleApprovalNotification } from '@/lib/notifications'
import { getAutoApproveProject, isSmtpConfigured } from '@/lib/settings'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { z } from 'zod'
import { logError, logMessage } from '@/lib/logging'
import { getCleanPreviewQueue } from '@/lib/queue'

export const runtime = 'nodejs'




const approveSchema = z.object({
  authorName: z.string().trim().max(100, 'Name too long').optional().nullable(),
  authorEmail: z.string().email().max(255, 'Email too long').optional().nullable(),
  selectedVideoId: z.string().min(1, 'Selected video is required'),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const projectMessages = messages?.projects || {}

  // Rate limiting: 20 approval actions per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: projectMessages.tooManyApprovalRequests || 'Too many approval requests. Please slow down.'
  }, 'project-approve')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id: projectId } = await params
    const body = await request.json()
    const parsed = approveSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }

    const { authorName, authorEmail, selectedVideoId } = parsed.data

    logMessage(`[APPROVAL] Starting approval process for project: ${projectId}`)
    logMessage(`[APPROVAL] Selected video: ${selectedVideoId}`)

    // SECURITY: Validate share password if project is password-protected
    // This allows clients to approve their own projects via the share link
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: projectMessages.projectNotFoundApi || 'Project not found' }, { status: 404 })
    }

    // Verify project access using dual auth pattern (clients can approve via share link)
    const accessCheck = await verifyProjectAccess(request, project.id, project.sharePassword, project.authMode, {
        requireVideoAccess: true,
      allowGuest: false,
      requiredAnyPermission: ['approve', 'comment'],
    })

    if (!accessCheck.authorized) {
      return NextResponse.json({
        error: projectMessages.passwordRequiredToApproveProject || 'Password required to approve this project'
      }, { status: 401 })
    }

    // SECURITY: Check if client is allowed to approve videos
    // If clientCanApprove is false, only admins can approve
    if (!accessCheck.isAdmin && project.clientCanApprove === false) {
      return NextResponse.json({
        error: projectMessages.onlyAdminsCanApproveProject || 'Only administrators can approve videos for this project'
      }, { status: 403 })
    }


    if (project.status === 'APPROVED') {
      return NextResponse.json({ error: projectMessages.projectAlreadyApproved || 'Project already approved' }, { status: 400 })
    }

    const selectedVideo = project.videos.find(v => v.id === selectedVideoId)

    if (!selectedVideo) {
      return NextResponse.json({ error: projectMessages.selectedVideoNotFound || 'Selected video not found' }, { status: 404 })
    }

    // Frameback review flow (src/lib/review.ts). All variants lock the version group and
    // keep "one approved version per video" atomically.
    //  - admin:                      override, any version
    //  - client, FEATURE_REVIEW_FLOW: only the current version that was sent "Zur Freigabe"
    //  - client, flag off:           legacy behaviour (any version), but recorded
    const actor = {
      name: authorName || 'Client', // unverified display name
      verifiedEmail: null, // never trust the body; verified identity comes with the share session (S1 step 2)
      ip: getClientIpAddress(request),
    }
    let applied = true
    try {
      if (accessCheck.isAdmin) {
        // Admin identity from the session, never from the body
        const admin = await getCurrentUserFromRequest(request)
        const result = await adminOverride({
          videoId: selectedVideoId,
          approved: true,
          adminUserId: admin?.id ?? null,
          actorName: admin?.name || admin?.email || 'Admin',
        })
        applied = result.changedApproval
      } else {
        const idempotencyKey = idempotencyKeyFrom(request.headers.get('idempotency-key'))
        const result = features.reviewFlow
          ? await clientDecide({ videoId: selectedVideoId, kind: 'APPROVE', actor, idempotencyKey })
          : await legacyClientApprove({ videoId: selectedVideoId, actor, idempotencyKey })
        applied = result.applied
      }
    } catch (error) {
      if (error instanceof ReviewError) {
        const status = error.code === 'INVALID_IDEMPOTENCY_KEY' ? 400 : 409
        return NextResponse.json({ error: error.message, code: error.code }, { status })
      }
      throw error
    }

    // Idempotent replay or nothing changed: do not repeat side effects (queue, notifications)
    if (!applied) {
      return NextResponse.json({ success: true, replayed: true })
    }

    // Queue clean preview generation if project uses preview for approved playback AND watermarks enabled
    if (project.usePreviewForApprovedPlayback && project.watermarkEnabled) {
      try {
        const cleanPreviewQueue = getCleanPreviewQueue()
        await cleanPreviewQueue.add('generate-clean-preview', {
          videoId: selectedVideoId,
          projectId: project.id,
          originalStoragePath: selectedVideo.originalStoragePath,
          resolution: project.previewResolution
        })
        logMessage(`[APPROVAL] Queued clean preview generation for video ${selectedVideoId}`)
      } catch (queueError) {
        logError('[APPROVAL] Failed to queue clean preview job:', queueError)
        // Don't fail the approval if queue fails
      }
    }

    // Check if all UNIQUE videos have at least one approved version
    const allVideos = await prisma.video.findMany({
      where: { projectId },
      select: { id: true, approved: true, name: true },
    })

    const videosByName = allVideos.reduce((acc: Record<string, any[]>, video) => {
      if (!acc[video.name]) {
        acc[video.name] = []
      }
      acc[video.name].push(video)
      return acc
    }, {})

    const allApproved = Object.values(videosByName).every((versions: any[]) =>
      versions.some(v => v.approved)
    )

    const autoApprove = await getAutoApproveProject()

    if (allApproved && autoApprove) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedVideoId: selectedVideoId, // Keep for backward compatibility
        },
      })

      // NOTE: Approval notifications are always sent immediately (see email sending code below)
      // They are NOT queued because approvals should notify clients right away
    }

    logMessage('[APPROVAL] Video approval complete, preparing notifications')

    // Handle approval notifications (will queue and/or send immediately based on schedule)
    try {
      const smtpConfigured = await isSmtpConfigured()
      logMessage(`[APPROVAL] SMTP configured: ${smtpConfigured}`)

      if (!smtpConfigured) {
        logMessage('[APPROVAL] SMTP not configured, skipping notifications')
      } else {
        // Determine if this is a complete project approval or partial
        // Complete = ALL unique videos have at least one approved version
        const isCompleteProjectApproval = allApproved && autoApprove

        // For complete approval, send all approved videos
        // For partial approval (single video), send only the just-approved video
        let approvedVideosList: Array<{ name: string; id: string }>
        if (isCompleteProjectApproval) {
          const approvedVideos = allVideos.filter(v => v.approved)
          approvedVideosList = approvedVideos.map(v => ({
            name: v.name,
            id: v.id
          }))
        } else {
          approvedVideosList = [{
            name: selectedVideo.name,
            id: selectedVideo.id
          }]
        }

        const safeAuthorName = authorName || undefined
        const safeAuthorEmail = authorEmail || undefined

        await handleApprovalNotification({
          project: {
            id: project.id,
            title: project.title,
            slug: project.slug,
            clientNotificationSchedule: project.clientNotificationSchedule,
            photoOnlyShare: project.photoOnlyShare,
          },
          approvedVideos: approvedVideosList,
          approved: true,
          authorName: safeAuthorName,
          authorEmail: safeAuthorEmail,
          isComplete: isCompleteProjectApproval,
        })
      }
    } catch (error) {
      logError('[APPROVAL] Error handling approval notifications:', error)
    }

    logMessage('[APPROVAL] Approval process complete, returning success')
    return NextResponse.json({ success: true })
  } catch (error) {
    logError('[APPROVAL] ERROR in approval route:', error)
    return NextResponse.json({ error: projectMessages.failedToApproveProjectApi || 'Failed to approve project' }, { status: 500 })
  }
}
