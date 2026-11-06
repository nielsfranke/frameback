/**
 * Frameback: email a client when the studio replies to one of their comments.
 *
 * No spam, by design:
 *  - opt-in only: the client entered an email with the comment (Comment.notifyReplies)
 *  - at most ONE mail per person and project per window; the window follows the project's
 *    client notification schedule (IMMEDIATE 15 min, HOURLY 1 h, DAILY 24 h, WEEKLY 7 d).
 *    Further replies in the window send nothing – the client sees them all via the link.
 *  - nothing extra for regular project recipients with notifications on (they already get
 *    the normal comment mails)
 *  - every mail carries an unsubscribe link (signed, per project + email)
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from './db'
import { getRedis } from './redis'
import { isSmtpConfigured } from './settings'
import { sendCommentNotificationEmail } from './email'
import { generateShareUrl } from './url'
import { logError, logMessage } from './logging'

const WINDOW_SECONDS: Record<string, number> = { IMMEDIATE: 15 * 60, HOURLY: 3600, DAILY: 86400, WEEKLY: 7 * 86400 }
export const replyMailWindow = (schedule?: string | null) => WINDOW_SECONDS[schedule ?? 'HOURLY'] ?? 3600

function secret() {
  const s = process.env.ENCRYPTION_KEY
  if (!s) throw new Error('ENCRYPTION_KEY missing')
  return s
}

export function replyUnsubscribeToken(projectId: string, email: string) {
  const payload = Buffer.from(JSON.stringify({ p: projectId, e: email.toLowerCase() })).toString('base64url')
  const sig = createHmac('sha256', secret()).update(`reply-unsub:${payload}`).digest('base64url').slice(0, 32)
  return `${payload}.${sig}`
}

export function readReplyUnsubscribeToken(token: string): { projectId: string; email: string } | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = Buffer.from(createHmac('sha256', secret()).update(`reply-unsub:${payload}`).digest('base64url').slice(0, 32))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const { p, e } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof p === 'string' && typeof e === 'string' ? { projectId: p, email: e } : null
  } catch {
    return null
  }
}

export async function notifyReplyAuthor(params: {
  parentId: string
  reply: { id: string; content: string; authorName?: string | null; timecode?: string | null }
  project: { id: string; title: string; slug: string; clientNotificationSchedule?: string | null }
  video: { name: string; versionLabel: string; fps?: number | null } | null
}) {
  const parent = await prisma.comment.findUnique({
    where: { id: params.parentId },
    select: { authorEmail: true, authorName: true, notifyReplies: true, isInternal: true, deletedAt: true, projectId: true },
  })
  if (!parent || parent.isInternal || parent.deletedAt || !parent.notifyReplies || !parent.authorEmail) return
  if (parent.projectId !== params.project.id) return
  const email = parent.authorEmail.toLowerCase()

  // Regular recipients with notifications already get the normal comment mail
  const recipient = await prisma.projectRecipient.findFirst({
    where: { projectId: params.project.id, email: { equals: email, mode: 'insensitive' }, receiveNotifications: true },
    select: { id: true },
  })
  if (recipient) return
  if (!(await isSmtpConfigured())) return

  // One mail per person, project and window
  const first = await getRedis().set(`reply_mail:${params.project.id}:${email}`, '1', 'EX', replyMailWindow(params.project.clientNotificationSchedule), 'NX')
  if (first !== 'OK') {
    logMessage(`[REPLY-MAIL] throttled for ${params.project.title}`)
    return
  }

  try {
    const shareUrl = await generateShareUrl(params.project.slug)
    const unsubscribeUrl = `${new URL(shareUrl).origin}/api/share/replies-unsubscribe?t=${encodeURIComponent(replyUnsubscribeToken(params.project.id, email))}`
    const result = await sendCommentNotificationEmail({
      clientEmail: email,
      clientName: parent.authorName || 'Client',
      projectTitle: params.project.title,
      videoName: params.video?.name || '',
      versionLabel: params.video?.versionLabel || '',
      authorName: params.reply.authorName || 'Studio',
      commentContent: params.reply.content,
      timecode: params.reply.timecode,
      fps: params.video?.fps,
      commentId: params.reply.id,
      shareUrl,
      unsubscribeUrl,
    })
    if (!result.success) logError('[REPLY-MAIL] send failed:', result.error)
  } catch (error) {
    logError('[REPLY-MAIL] send failed:', error)
  }
}
