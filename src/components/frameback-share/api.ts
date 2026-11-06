/**
 * Frameback share view: small client helpers around the existing share APIs.
 * Every request carries the share token as Bearer (sessionStorage, see share-token-store).
 */
export interface ShareVideo {
  id: string
  name: string
  version: number
  versionLabel: string
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR'
  approved?: boolean
  approvedAt?: string | null
  duration: number
  fps?: number | null
  width?: number
  height?: number
  createdAt: string
  hasAssets?: boolean
  originalFileName?: string
  originalFileSize?: string
  reviewState?: 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'
  versionNote?: string | null
}

export interface ShareComment {
  id: string
  videoId: string
  videoVersion?: number | null
  timecode: string
  content: string
  authorName?: string | null
  isInternal: boolean
  createdAt: string
  editedAt?: string | null
  deleted?: boolean
  canEdit?: boolean
  parentId?: string | null
  replies?: ShareComment[]
}

export interface VideoUrls {
  stream: string
  poster: string | null
}

export const authHeaders = (shareToken: string | null, json = false): HeadersInit => ({
  ...(shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
  ...(json ? { 'Content-Type': 'application/json' } : {}),
})

async function videoToken(slug: string, shareToken: string | null, videoId: string, quality: string) {
  const res = await fetch(`/api/share/${slug}/video-token?videoId=${encodeURIComponent(videoId)}&quality=${quality}`, {
    headers: authHeaders(shareToken),
    cache: 'no-store',
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.token ? `/api/content/${data.token}` : null
}

/** Stream URL (preferred quality with fallbacks) and poster for one version. */
export async function loadVideoUrls(
  slug: string,
  shareToken: string | null,
  video: ShareVideo,
  quality: '720p' | '1080p' | '2160p'
): Promise<VideoUrls> {
  const order = quality === '2160p' ? ['2160p', '1080p', '720p'] : quality === '1080p' ? ['1080p', '720p'] : ['720p', '1080p']
  let stream: string | null = null
  for (const q of order) {
    stream = await videoToken(slug, shareToken, video.id, q)
    if (stream) break
  }
  const poster = await videoToken(slug, shareToken, video.id, 'thumbnail')
  return { stream: stream ?? '', poster }
}

export const posterUrl = (slug: string, shareToken: string | null, videoId: string) =>
  videoToken(slug, shareToken, videoId, 'thumbnail')

export function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function formatSeconds(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export const initials = (name?: string | null) =>
  (name || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase()
