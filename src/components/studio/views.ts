/** Studio overview views: URL <-> filter, shared by the sidebar and the list. */
import type { ProjectSummary } from '@/lib/studio'

export type StudioProject = ProjectSummary & { thumbnailUrl: string | null }
export interface StudioFolder { id: string; name: string; sortOrder: number }

export type View =
  | { kind: 'all' } | { kind: 'feedback' } | { kind: 'review' } | { kind: 'archive' }
  | { kind: 'nofolder' } | { kind: 'folder'; id: string }

export function viewFromParams(sp: URLSearchParams | null): View {
  const folder = sp?.get('folder')
  if (folder) return folder === 'none' ? { kind: 'nofolder' } : { kind: 'folder', id: folder }
  const v = sp?.get('view')
  if (v === 'feedback' || v === 'review' || v === 'archive') return { kind: v }
  return { kind: 'all' }
}

export function viewHref(v: View): string {
  switch (v.kind) {
    case 'all': return '/admin/projects'
    case 'nofolder': return '/admin/projects?folder=none'
    case 'folder': return `/admin/projects?folder=${encodeURIComponent(v.id)}`
    default: return `/admin/projects?view=${v.kind}`
  }
}

export const sameView = (a: View, b: View) => a.kind === b.kind && (a.kind !== 'folder' || (b.kind === 'folder' && a.id === b.id))

export function inView(p: StudioProject, v: View): boolean {
  switch (v.kind) {
    case 'all': return !p.archived
    case 'feedback': return !p.archived && p.unread > 0
    case 'review': return !p.archived && p.waiting > 0
    case 'archive': return p.archived
    case 'nofolder': return !p.archived && !p.folder
    case 'folder': return !p.archived && p.folder?.id === v.id
  }
}

export const countIn = (projects: StudioProject[], v: View) => projects.filter((p) => inView(p, v)).length

export const clientName = (p: StudioProject) => p.client?.name || p.companyName || null

export function matchesQuery(p: StudioProject, q: string) {
  const needle = q.trim().toLocaleLowerCase()
  if (!needle) return true
  return [p.title, clientName(p) ?? '', p.folder?.name ?? ''].some((s) => s.toLocaleLowerCase().includes(needle))
}

/** Drag payload when projects are dragged onto a folder in the sidebar */
export const DRAG_TYPE = 'application/x-frameback-projects'
