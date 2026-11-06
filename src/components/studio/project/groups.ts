/** Video groups of a project as the studio sees them (shared by project page and player). */
import { groupState, type GroupState } from '@/lib/studio'

export interface AdminVideo {
  id: string
  name: string
  groupId: string
  version: number
  versionLabel: string
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR'
  reviewState: 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'
  approved: boolean
  versionNote?: string | null
  thumbnailPath?: string | null
  duration?: number | null
  fps?: number | null
  width?: number | null
  height?: number | null
  createdAt: string
  group?: { sortOrder: number } | null
  [k: string]: unknown
}

export interface AdminComment {
  id: string
  videoId: string
  parentId?: string | null
  isInternal: boolean
  userId?: string | null
  deletedAt?: string | null
  resolvedAt?: string | null
  createdAt: string
  replies?: AdminComment[]
  [k: string]: unknown
}

export interface Group {
  groupId: string
  name: string
  sortOrder: number
  /** all versions, newest first */
  versions: AdminVideo[]
  /** highest READY version: what the client sees */
  current: AdminVideo | null
  /** newer upload that is not ready yet */
  pending: AdminVideo | null
  state: GroupState
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function buildGroups(videos: AdminVideo[]): Group[] {
  const by = new Map<string, AdminVideo[]>()
  for (const v of videos) by.set(v.groupId, [...(by.get(v.groupId) ?? []), v])
  const groups = [...by.entries()].map(([groupId, list]) => {
    const versions = [...list].sort((a, b) => b.version - a.version)
    const current = versions.find((v) => v.status === 'READY') ?? null
    const pending = versions[0] && versions[0] !== current && versions[0].status !== 'ERROR' ? versions[0] : null
    return {
      groupId,
      name: versions[0].name,
      sortOrder: versions[0].group?.sortOrder ?? 0,
      versions,
      current,
      pending,
      state: current ? groupState(current) : 'draft',
    } satisfies Group
  })
  // same order as the client view: positioned first (1..n), then natural name order
  const pos = (g: Group) => g.sortOrder || Number.MAX_SAFE_INTEGER
  return groups.sort((a, b) => pos(a) - pos(b) || natural.compare(a.name, b.name))
}

export const isClientComment = (c: AdminComment) => !c.isInternal && !c.userId && !c.deletedAt

/** Open = client threads on the current version that the studio has not marked done. */
export function openThreads(comments: AdminComment[], g: Group) {
  if (!g.current) return 0
  return comments.filter((c) => !c.parentId && c.videoId === g.current!.id && isClientComment(c) && !c.resolvedAt).length
}

/** Unread client comments (threads and replies) on any version of the group. */
export function unreadIn(comments: AdminComment[], g: Group, unread: Set<string>) {
  const ids = new Set(g.versions.map((v) => v.id))
  let n = 0
  for (const c of comments) {
    if (ids.has(c.videoId) && unread.has(c.id)) n++
    for (const r of c.replies ?? []) if (ids.has(r.videoId ?? c.videoId) && unread.has(r.id)) n++
  }
  return n
}
