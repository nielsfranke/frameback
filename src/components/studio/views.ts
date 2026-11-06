/** Studio overview views: URL <-> filter, shared by the sidebar and the list. */
import type { ProjectSummary } from '@/lib/studio'

export type StudioProject = ProjectSummary & { thumbnailUrl: string | null }
export interface StudioFolder { id: string; name: string; parentId: string | null; sortOrder: number }

export type View =
  | { kind: 'all' } | { kind: 'feedback' } | { kind: 'review' } | { kind: 'done' } | { kind: 'archive' }
  | { kind: 'nofolder' } | { kind: 'folder'; id: string }

export function viewFromParams(sp: URLSearchParams | null): View {
  const folder = sp?.get('folder')
  if (folder) return folder === 'none' ? { kind: 'nofolder' } : { kind: 'folder', id: folder }
  const v = sp?.get('view')
  if (v === 'feedback' || v === 'review' || v === 'done' || v === 'archive') return { kind: v }
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

/**
 * Lists: active = neither archived nor done. New feedback shows up even on done projects.
 * Folder views are a file browser: everything filed there except the archive.
 */
export function inView(p: StudioProject, v: View): boolean {
  switch (v.kind) {
    case 'all': return !p.archived && !p.completed
    case 'feedback': return !p.archived && p.unread > 0
    case 'review': return !p.archived && !p.completed && p.waiting > 0
    case 'done': return !p.archived && p.completed
    case 'archive': return p.archived
    case 'nofolder': return !p.archived && !p.folder
    case 'folder': return !p.archived && p.folder?.id === v.id
  }
}

export const countIn = (projects: StudioProject[], v: View) => projects.filter((p) => inView(p, v)).length

// --- folder tree --------------------------------------------------------------------------

export const childFolders = (folders: StudioFolder[], parentId: string | null) =>
  folders.filter((f) => (f.parentId ?? null) === parentId)

/** Root first: [Kunde, 2026, Kampagne] */
export function folderPath(folders: StudioFolder[], id: string | null): StudioFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: StudioFolder[] = []
  for (let f = id ? byId.get(id) : undefined; f && out.length <= folders.length; f = f.parentId ? byId.get(f.parentId) : undefined) out.unshift(f)
  return out
}

/** The folder and everything below it */
export function subtreeIds(folders: StudioFolder[], id: string): Set<string> {
  const ids = new Set([id])
  for (let grew = true; grew;) {
    grew = false
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true }
  }
  return ids
}

/** Projects in the folder or any subfolder (archive excluded, like the folder view) */
export function countInTree(projects: StudioProject[], folders: StudioFolder[], id: string) {
  const ids = subtreeIds(folders, id)
  return projects.filter((p) => !p.archived && p.folder && ids.has(p.folder.id)).length
}

export const MAX_FOLDER_DEPTH = 4
const height = (folders: StudioFolder[], id: string): number => 1 + Math.max(0, ...childFolders(folders, id).map((c) => height(folders, c.id)))
/** Can folder `id` (null = a new one) go into `parentId` without a cycle or exceeding the depth? */
export function canNestIn(folders: StudioFolder[], id: string | null, parentId: string | null) {
  if (!parentId) return true
  if (id && subtreeIds(folders, id).has(parentId)) return false
  return folderPath(folders, parentId).length + (id ? height(folders, id) : 1) <= MAX_FOLDER_DEPTH
}

export const clientName = (p: StudioProject) => p.client?.name || p.companyName || null

export function matchesQuery(p: StudioProject, q: string) {
  const needle = q.trim().toLocaleLowerCase()
  if (!needle) return true
  return [p.title, clientName(p) ?? '', p.folder?.name ?? ''].some((s) => s.toLocaleLowerCase().includes(needle))
}

/** Drag payload when projects are dragged onto a folder (sidebar or folder tiles) */
export const DRAG_TYPE = 'application/x-frameback-projects'
/** Drag payload when a folder is dragged into another folder */
export const FOLDER_DRAG_TYPE = 'application/x-frameback-folder'
