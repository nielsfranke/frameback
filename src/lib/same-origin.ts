/**
 * Frameback: CSRF protection for cookie-authenticated write endpoints.
 *
 * Trust anchor is an explicit allowlist from configuration – never request headers
 * (Host / X-Forwarded-* can be influenced in front of the app):
 *   NEXT_PUBLIC_APP_URL            e.g. https://review.example.com
 *   ALLOWED_ORIGINS (optional)     comma separated extra origins, e.g. the LAN staging URLs
 *
 * A write is accepted when
 *  - its Origin header is in the allowlist, or
 *  - it has no Origin header but an Authorization: Bearer header. Browsers always send
 *    Origin on cross-site POST/PATCH/DELETE, and a foreign site cannot attach a bearer
 *    token (they live in the app's own storage), so this only admits non-browser clients
 *    such as the Resolve MCP. The route still authenticates that bearer token.
 */
import { NextRequest, NextResponse } from 'next/server'

let cached: { key: string; set: Set<string> } | null = null

export function allowedOrigins(): Set<string> {
  const key = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}|${process.env.ALLOWED_ORIGINS ?? ''}`
  if (cached?.key === key) return cached.set
  const set = new Set<string>()
  for (const raw of [process.env.NEXT_PUBLIC_APP_URL, ...(process.env.ALLOWED_ORIGINS ?? '').split(',')]) {
    const value = raw?.trim()
    if (!value) continue
    try { set.add(new URL(value).origin) } catch { /* ignore invalid entries */ }
  }
  cached = { key, set }
  return set
}

/** Returns a 403 response for cross-origin writes, or null when the request may proceed. */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin')
  if (!origin) {
    const bearer = request.headers.get('authorization')?.startsWith('Bearer ')
    return bearer ? null : NextResponse.json({ error: 'Origin required' }, { status: 403 })
  }
  return allowedOrigins().has(origin) ? null : NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 })
}
