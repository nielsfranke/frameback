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

const ONE_YEAR = 60 * 60 * 24 * 365
const secureMode = () => process.env.HTTPS_ENABLED === 'true'
/**
 * Under HTTPS the cookie uses the __Host- prefix: the browser then enforces Secure,
 * Path=/ and no Domain attribute, so a sibling subdomain cannot plant or overwrite it.
 */
export const viewerCookieName = () => (secureMode() ? '__Host-vt_viewer' : 'vt_viewer')
export const VIEWER_COOKIE = 'vt_viewer' // plain-HTTP name (LAN staging / development)

function secret() {
  const s = process.env.ENCRYPTION_KEY
  if (!s) throw new Error('ENCRYPTION_KEY missing')
  return s
}

const sign = (key: string) => createHmac('sha256', secret()).update(`vt_viewer:${key}`).digest('hex').slice(0, 32)

/** Returns the verified viewer key from the request cookie, or null. */
export function readViewerKey(request: NextRequest): string | null {
  const raw = request.cookies.get(viewerCookieName())?.value
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length !== 2) return null
  const [key, sig] = parts
  if (!/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{32}$/.test(sig)) return null
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
  response.cookies.set(viewerCookieName(), `${key}.${sign(key)}`, {
    httpOnly: true,
    secure: secureMode(),
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
      // Explicit placeholder: only structural fields survive (no author, user, key hash, assets)
      out.push({
        id: c.id, projectId: c.projectId, videoId: c.videoId, videoVersion: c.videoVersion,
        timecode: c.timecode, timecodeEnd: c.timecodeEnd, parentId: c.parentId ?? null,
        isInternal: c.isInternal, createdAt: c.createdAt, updatedAt: c.updatedAt,
        deletedAt: c.deletedAt, content: '', authorName: null, authorEmail: null, user: null, userId: null,
        annotations: null, assets: [], deleted: true, replies,
      } as unknown as T)
    } else {
      out.push({ ...c, replies } as unknown as T)
    }
  }
  return out
}
