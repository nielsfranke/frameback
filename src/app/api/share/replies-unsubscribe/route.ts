import { NextRequest, NextResponse } from 'next/server'
import { optOut, readReplyUnsubscribeToken } from '@/lib/reply-notifications'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const page = (title: string, text: string, status = 200) =>
  new NextResponse(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}</style></head>` +
      `<body><h1>${title}</h1><p>${text}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }
  )

// GET shows a confirmation page (mail link scanners must not unsubscribe people);
// the button POSTs back to perform the opt-out.
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' }, 'reply-unsubscribe')
  if (limited) return limited
  const t = request.nextUrl.searchParams.get('t') ?? ''
  if (!readReplyUnsubscribeToken(t)) return page('Link ungültig', 'Dieser Abmelde-Link ist ungültig oder unvollständig.', 400)
  const safe = t.replace(/[^A-Za-z0-9._-]/g, '')
  return page('Abmelden?', `Keine Mails mehr bekommen, wenn das Studio auf deine Kommentare in diesem Projekt antwortet? / Stop reply emails for this project?</p>
    <form method="post"><input type="hidden" name="t" value="${safe}"><button type="submit" style="font:inherit;padding:.6rem 1.2rem;border-radius:.6rem;border:0;background:#2563eb;color:#fff;cursor:pointer">Abmelden / Unsubscribe</button></form><p>`)
}

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 30, message: 'Too many requests.' }, 'reply-unsubscribe')
  if (limited) return limited
  const form = await request.formData().catch(() => null)
  const data = readReplyUnsubscribeToken(String(form?.get('t') ?? request.nextUrl.searchParams.get('t') ?? ''))
  if (!data) return page('Link ungültig', 'Dieser Abmelde-Link ist ungültig oder unvollständig.', 400)
  await optOut(data.projectId, data.email)
  return page('Abgemeldet', 'Du bekommst für dieses Projekt keine Mails mehr, wenn das Studio auf deine Kommentare antwortet. / You will no longer receive reply emails for this project.')
}
