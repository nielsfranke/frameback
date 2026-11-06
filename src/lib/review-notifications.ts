/**
 * Frameback: tell the client that a version is ready for review ("Zur Freigabe senden").
 * Reuses the existing NEW_VERSION email template (editable under Settings → Email templates),
 * per-recipient locale and unsubscribe links. Only recipients with notifications on; one mail
 * per review request – studio-initiated, so no throttling needed beyond that.
 */
import { prisma } from './db'
import { getRecipientLocale, sendNewVersionEmail } from './email'
import { generateShareUrl } from './url'
import { getProjectRecipients } from './recipients'
import { buildUnsubscribeUrl, generateRecipientUnsubscribeToken } from './unsubscribe'
import { isSmtpConfigured } from './settings'
import { logError, logMessage } from './logging'

export async function notifyClientsReviewRequested(videoId: string): Promise<{ sent: number; skipped?: string }> {
  if (!(await isSmtpConfigured())) return { sent: 0, skipped: 'smtp' }
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { name: true, versionLabel: true, project: { select: { id: true, title: true, slug: true, sharePassword: true } } },
  })
  if (!video) return { sent: 0, skipped: 'video' }
  const { project } = video
  const recipients = (await getProjectRecipients(project.id)).filter((r) => r.email && r.receiveNotifications)
  if (recipients.length === 0) return { sent: 0, skipped: 'no recipients' }

  const shareUrl = await generateShareUrl(project.slug)
  const results = await Promise.allSettled(recipients.map(async (r) => {
    let unsubscribeUrl: string | undefined
    try {
      unsubscribeUrl = buildUnsubscribeUrl(
        new URL(shareUrl).origin,
        generateRecipientUnsubscribeToken({ recipientId: r.id!, projectId: project.id, recipientEmail: r.email! })
      )
    } catch { unsubscribeUrl = undefined }
    const result = await sendNewVersionEmail({
      clientEmail: r.email!,
      clientName: r.name || 'Client',
      projectTitle: project.title,
      videoName: video.name,
      versionLabel: video.versionLabel,
      shareUrl: `${shareUrl}?video=${encodeURIComponent(video.name)}`,
      isPasswordProtected: !!project.sharePassword,
      unsubscribeUrl,
      locale: await getRecipientLocale(r.email!),
    })
    if (!result?.success) throw new Error(result?.error || 'send failed')
  }))
  const sent = results.filter((x) => x.status === 'fulfilled').length
  results.forEach((x) => { if (x.status === 'rejected') logError('[REVIEW-MAIL] failed:', x.reason) })
  logMessage(`[REVIEW-MAIL] "${video.name} ${video.versionLabel}" ready for review: ${sent}/${recipients.length} recipients notified`)
  return { sent }
}
