'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Archive, ChevronRight, Folder, Plus } from 'lucide-react'
import { useStudioData } from './StudioData'
import { useStudioActions } from './useStudioActions'
import { FolderNameDialog } from './FolderDialogs'
import { canNestIn, childFolders, countIn, countInTree, DRAG_TYPE, folderPath, FOLDER_DRAG_TYPE, sameView, viewFromParams, viewHref, type StudioFolder, type View } from './views'

const LAST_VIEW_KEY = 'studio:lastView'
const OPEN_FOLDERS_KEY = 'studio:openFolders'

/** Remember the view a project was opened from, so the sidebar keeps showing it. */
export function rememberView(v: View) {
  try { sessionStorage.setItem(LAST_VIEW_KEY, JSON.stringify(v)) } catch { /* private mode */ }
}
function lastView(): View | null {
  try { const s = sessionStorage.getItem(LAST_VIEW_KEY); return s ? (JSON.parse(s) as View) : null } catch { return null }
}

const item = 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors'
const idle = 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
const active = 'bg-primary text-primary-foreground shadow-elevation'

function Count({ n, hot, on }: { n: number; hot?: boolean; on: boolean }) {
  if (hot && n > 0) return <span className={`ml-auto rounded-full px-1.5 text-xs font-bold leading-[18px] tabular-nums ${on ? 'bg-primary-foreground text-primary' : 'bg-primary text-primary-foreground'}`}>{n}</span>
  return <span className={`ml-auto text-xs tabular-nums ${on ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{n}</span>
}

function Inner({ projectsLabel, projectsIcon }: { projectsLabel: string; projectsIcon: React.ReactNode }) {
  const t = useTranslations('studio')
  const pathname = usePathname()
  const sp = useSearchParams()
  const { projects, folders } = useStudioData()
  const { move, moveFolder, createFolder } = useStudioActions()
  const [creating, setCreating] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [origin, setOrigin] = useState<View | null>(null)
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    try { setOpenIds(new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '[]') as string[])) } catch { /* private mode */ }
  }, [])
  const toggleOpen = (id: string) => setOpenIds((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    try { localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...n])) } catch { /* private mode */ }
    return n
  })

  const onOverview = pathname === '/admin/projects'
  const inProject = !!pathname?.startsWith('/admin/projects/') && pathname !== '/admin/projects/new'
  useEffect(() => { if (inProject) setOrigin(lastView()) }, [inProject, pathname])
  const current: View | null = onOverview ? viewFromParams(sp) : inProject ? origin ?? { kind: 'all' } : null
  const isOn = (v: View) => !!current && sameView(current, v)
  // the way to the current folder is always unfolded
  const currentPath = new Set(current?.kind === 'folder' ? folderPath(folders, current.id).slice(0, -1).map((f) => f.id) : [])

  /** Drop projects (move) or a folder (nest) onto a folder; null = top level / no folder */
  const dropProps = (key: string, folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types
      if (types.includes(DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(key) }
    },
    onDragLeave: () => setDropTarget((d) => (d === key ? null : d)),
    onDrop: (e: React.DragEvent) => {
      setDropTarget(null)
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      const folderRaw = e.dataTransfer.getData(FOLDER_DRAG_TYPE)
      if (!raw && !folderRaw) return
      e.preventDefault()
      if (folderRaw) {
        const f = folders.find((x) => x.id === folderRaw)
        if (f && (f.parentId ?? null) !== folderId && canNestIn(folders, f.id, folderId)) void moveFolder(f.id, folderId)
        return
      }
      try { void move(JSON.parse(raw) as string[], folderId) } catch { /* foreign payload */ }
    },
  })
  const dropRing = (key: string) => (dropTarget === key ? 'ring-2 ring-primary bg-primary/10' : '')

  const link = (v: View, label: React.ReactNode, icon: React.ReactNode, opts: { sub?: boolean; hot?: boolean } = {}) => {
    const on = isOn(v)
    return (
      <Link
        key={v.kind}
        href={viewHref(v)}
        aria-current={on ? 'page' : undefined}
        className={`${item} ${on ? active : idle} ${opts.sub ? 'py-1.5 pl-11 text-[13px]' : ''}`}
      >
        {icon}
        <span className="truncate">{label}</span>
        <Count n={countIn(projects, v)} hot={opts.hot} on={on} />
      </Link>
    )
  }

  const folderNode = (f: StudioFolder, depth: number): React.ReactNode => {
    const v: View = { kind: 'folder', id: f.id }
    const on = isOn(v)
    const key = `f:${f.id}`
    const kids = childFolders(folders, f.id)
    const expanded = kids.length > 0 && (openIds.has(f.id) || currentPath.has(f.id))
    return (
      <div key={f.id}>
        <div className="relative">
          {kids.length > 0 && (
            <button
              type="button"
              onClick={() => toggleOpen(f.id)}
              aria-label={t(expanded ? 'collapseFolder' : 'expandFolder', { name: f.name })}
              aria-expanded={expanded}
              className={`absolute top-1/2 z-10 -translate-y-1/2 rounded p-0.5 ${on ? 'text-primary-foreground hover:bg-white/15' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
              style={{ left: `${depth * 14 + 4}px` }}
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          )}
          <Link
            href={viewHref(v)}
            aria-current={on ? 'page' : undefined}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(FOLDER_DRAG_TYPE, f.id); e.dataTransfer.effectAllowed = 'move' }}
            className={`${item} ${on ? active : idle} ${dropRing(key)}`}
            style={{ paddingLeft: `${depth * 14 + 24}px` }}
            {...dropProps(key, f.id)}
          >
            <Folder className="h-4 w-4 shrink-0" />
            <span className="truncate">{f.name}</span>
            <Count n={countInTree(projects, folders, f.id)} on={on} />
          </Link>
        </div>
        {expanded && kids.map((c) => folderNode(c, depth + 1))}
      </div>
    )
  }

  const rootOn = isOn({ kind: 'nofolder' })
  return (
    <>
      {link({ kind: 'all' }, projectsLabel, projectsIcon)}
      {link({ kind: 'feedback' }, t('viewFeedback'), null, { sub: true, hot: true })}
      {link({ kind: 'review' }, t('viewReview'), null, { sub: true })}
      {link({ kind: 'done' }, t('viewDone'), null, { sub: true })}

      <div className="flex items-center gap-1 pb-1 pt-4">
        <Link
          href={viewHref({ kind: 'nofolder' })}
          aria-current={rootOn ? 'page' : undefined}
          title={t('allFolders')}
          className={`flex-1 rounded-md px-3 py-1 text-xs font-semibold ${rootOn ? 'text-primary' : 'text-muted-foreground hover:text-foreground'} ${dropRing('root')}`}
          {...dropProps('root', null)}
        >
          {t('folders')}
        </Link>
        <button type="button" onClick={() => setCreating(true)} className="mr-2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t('newFolder')} title={t('newFolder')}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {childFolders(folders, null).map((f) => folderNode(f, 0))}
      {folders.length === 0 && <Link href={viewHref({ kind: 'nofolder' })} className="block px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">{t('noFoldersYet')}</Link>}
      <div className="mx-2 my-3 border-t border-border/60" />
      {link({ kind: 'archive' }, t('archive'), <Archive className="h-4 w-4 shrink-0" />)}

      <FolderNameDialog open={creating} onOpenChange={setCreating} title={t('newFolder')} onSubmit={(name) => createFolder(name)} />
    </>
  )
}

/** Sidebar block for FEATURE_STUDIO_V2: views and folders nested under "Projekte". */
export default function StudioNav(props: { projectsLabel: string; projectsIcon: React.ReactNode }) {
  return <Suspense fallback={null}><Inner {...props} /></Suspense>
}
