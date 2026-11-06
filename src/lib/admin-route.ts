import { NextRequest, NextResponse } from 'next/server'
import { rejectCrossOrigin } from './same-origin'
import { requireApiAdmin } from './auth'
import { rateLimit } from './rate-limit'
import { FolderError } from './folders'
import { logError } from './logging'

/** Same-origin (for writes), admin session and a per-route rate limit. */
export async function adminGuard(request: NextRequest, name: string, maxPerMinute = 60, write = true) {
  if (write) {
    const crossOrigin = rejectCrossOrigin(request)
    if (crossOrigin) return crossOrigin
  }
  const admin = await requireApiAdmin(request)
  if (admin instanceof Response) return admin
  const limited = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: maxPerMinute, message: 'Too many requests.' }, name)
  if (limited) return limited
  return admin
}

export function folderErrorResponse(error: unknown, tag: string) {
  if (error instanceof FolderError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID' ? 400 : 409
    return NextResponse.json({ error: error.message, code: error.code }, { status })
  }
  logError(`[${tag}]`, error)
  return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
}
