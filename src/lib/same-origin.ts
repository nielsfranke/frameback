/**
 * Frameback: CSRF protection for cookie-authenticated write endpoints.
 *
 * Browsers send an Origin header on POST/PATCH/DELETE fetches. A write is accepted when
 *  - the Origin matches the request's own host (or NEXT_PUBLIC_APP_URL), or
 *  - there is no Origin but an Authorization: Bearer header (non-browser clients such as
 *    the Resolve MCP – a bearer token cannot be attached by a foreign site).
 * Everything else is refused with 403.
 */
import { NextRequest, NextResponse } from 'next/server'

function allowedOrigins(request: NextRequest): Set<string> {
  const set = new Set<string>()
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '')
  if (host) set.add(`${proto}://${host}`)
  set.add(request.nextUrl.origin)
  try { if (process.env.NEXT_PUBLIC_APP_URL) set.add(new URL(process.env.NEXT_PUBLIC_APP_URL).origin) } catch { /* ignore */ }
  return set
}

/** Returns a 403 response for cross-origin writes, or null when the request may proceed. */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get('origin')
  if (!origin) {
    const bearer = request.headers.get('authorization')?.startsWith('Bearer ')
    return bearer ? null : NextResponse.json({ error: 'Origin required' }, { status: 403 })
  }
  return allowedOrigins(request).has(origin) ? null : NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 })
}
