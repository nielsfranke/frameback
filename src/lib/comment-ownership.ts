/**
 * Frameback: comment ownership without accounts (docs/redesign/PLAN.md §3.4).
 *
 * The browser gets a server-issued, signed key in the httpOnly cookie `vt_viewer`.
 * Comments store sha256(key) as authorKeyHash. Editing/deleting own comments requires
 * share access to the project AND a matching key – or an admin.
 *
 * The key is signed (HMAC with ENCRYPTION_KEY), so only keys issued by this server are
 * accepted: a value planted from outside (cookie fixation) is ignored and replaced.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextRequest, NextResponse } from 'next/server'
import { hashViewerKey } from './review'

export const VIEWER_COOKIE = 'vt_viewer'
const ONE_YEAR = 60 * 60 * 24 * 365

function secret() {
  const s = process.env.ENCRYPTION_KEY
  if (!s) throw new Error('ENCRYPTION_KEY missing')
  return s
}

const sign = (key: string) => createHmac('sha256', secret()).update(`vt_viewer:${key}`).digest('hex').slice(0, 32)

/** Returns the verified viewer key from the request cookie, or null. */
export function readViewerKey(request: NextRequest): string | null {
  const raw = request.cookies.get(VIEWER_COOKIE)?.value
  if (!raw) return null
  const [key, sig] = raw.split('.')
  if (!key || !sig || !/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{32}$/.test(sig)) return null
  const expected = Buffer.from(sign(key))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given) ? key : null
}

/** Existing verified key, or a new one that the caller must persist with setViewerCookie. */
export function viewerKeyFor(request: NextRequest): { key: string; isNew: boolean } {
  const existing = readViewerKey(request)
  return existing ? { key: existing, isNew: false } : { key: randomBytes(32).toString('hex'), isNew: true }
}

export function setViewerCookie(response: NextResponse, key: string) {
  response.cookies.set(VIEWER_COOKIE, `${key}.${sign(key)}`, {
    httpOnly: true,
    secure: process.env.HTTPS_ENABLED === 'true',
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR,
  })
  return response
}

export const viewerHashFrom = (request: NextRequest) => {
  const key = readViewerKey(request)
  return key ? hashViewerKey(key) : null
}

/**
 * Soft-delete visibility for a top-level comment list with nested replies:
 *  - deleted replies disappear
 *  - a deleted top-level comment with visible replies stays as a placeholder
 *    (content blanked, author removed) so studio answers keep their context
 *  - a deleted top-level comment without visible replies disappears
 */
export function applySoftDelete<T>(comments: T[]): T[] {
  type C = { deletedAt?: Date | null; replies?: C[] } & Record<string, unknown>
  const out: T[] = []
  for (const c of comments as unknown as C[]) {
    const replies = (c.replies ?? []).filter((r) => !r.deletedAt)
    if (c.deletedAt) {
      if (replies.length === 0) continue
      out.push({
        ...c, replies, content: '', authorName: null, authorEmail: null, annotations: null, assets: [], deleted: true,
      } as unknown as T)
    } else {
      out.push({ ...c, replies } as unknown as T)
    }
  }
  return out
}
