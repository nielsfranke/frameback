import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { unapproveProject } from '@/lib/review'
import { requireApiAdmin } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getConfiguredLocale, loadLocaleMessages } from '@/i18n/locale'
import { z } from 'zod'
import { logError } from '@/lib/logging'

export const runtime = 'nodejs'




const unapproveSchema = z.object({
  unapproveVideos: z.boolean().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const locale = await getConfiguredLocale().catch(() => 'en')
  const messages = await loadLocaleMessages(locale).catch(() => null)
  const projectMessages = messages?.projects || {}

  // SECURITY: Require admin authentication
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  // Rate limiting: 20 unapproval actions per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: projectMessages.tooManyRequestsGeneric || 'Too many requests. Please slow down.'
  }, 'admin-unapprove')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id: projectId } = await params

    // Parse request body to get unapprove options
    const body = await request.json().catch(() => ({}))
    const parsed = unapproveSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 })
    }
    const { unapproveVideos = true } = parsed.data // Default to true for backward compatibility

    // Get project details
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        videos: {
          select: { id: true, approved: true }
        }
      }
    })

    if (!project) {
      return NextResponse.json({ error: projectMessages.projectNotFoundApi || 'Project not found' }, { status: 404 })
    }

    // Frameback: videos (optional), open rounds and project status reset in one locked
    // transaction via the review flow; every change is logged.
    const unapprovedCount = await unapproveProject({
      projectId,
      adminUserId: authResult.id,
      actorName: authResult.name || authResult.email || 'Admin',
      resetVideos: unapproveVideos,
    })

    return NextResponse.json({
      success: true,
      unapprovedCount,
      unapprovedVideos: unapproveVideos
    })
  } catch (error) {
    logError('Error unapproving project:', error)
    return NextResponse.json(
      { error: projectMessages.failedToUnapproveProjectApi || 'Failed to unapprove project' },
      { status: 500 }
    )
  }
}
