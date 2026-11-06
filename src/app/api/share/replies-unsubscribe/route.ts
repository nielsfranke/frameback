import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { readReplyUnsubscribeToken } from '@/lib/reply-notifications'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const page = (title: string, text: string, status = 200) =>
  new NextResponse(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}</style></head>` +
      `<body><h1>${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  )

// GET /api/share/replies-unsubscribe?t=… – stop "the studio replied" mails for this project
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' }, 'reply-unsubscribe')
  if (limited) return limited
  const data = readReplyUnsubscribeToken(request.nextUrl.searchParams.get('t') ?? '')
  if (!data) return page('Link ungültig', 'Dieser Abmelde-Link ist ungültig oder unvollständig.', 400)
  await prisma.comment.updateMany({
    where: { projectId: data.projectId, authorEmail: { equals: data.email, mode: 'insensitive' } },
    data: { notifyReplies: false },
  })
  return page('Abgemeldet', 'Du bekommst für dieses Projekt keine Mails mehr, wenn das Studio auf deine Kommentare antwortet. / You will no longer receive reply emails for this project.')
}
