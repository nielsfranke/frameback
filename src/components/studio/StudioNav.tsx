'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Archive, Folder, Plus } from 'lucide-react'
import { useStudioData } from './StudioData'
import { useStudioActions } from './useStudioActions'
import { FolderNameDialog } from './FolderDialogs'
import { countIn, DRAG_TYPE, sameView, viewFromParams, viewHref, type View } from './views'

const LAST_VIEW_KEY = 'studio:lastView'

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
  const { move, createFolder } = useStudioActions()
  const [creating, setCreating] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [origin, setOrigin] = useState<View | null>(null)

  const onOverview = pathname === '/admin/projects'
  const inProject = !!pathname?.startsWith('/admin/projects/') && pathname !== '/admin/projects/new'
  useEffect(() => { if (inProject) setOrigin(lastView()) }, [inProject, pathname])
  const current: View | null = onOverview ? viewFromParams(sp) : inProject ? origin ?? { kind: 'all' } : null
  const isOn = (v: View) => !!current && sameView(current, v)

  const dropProps = (key: string, folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(key) } },
    onDragLeave: () => setDropTarget((d) => (d === key ? null : d)),
    onDrop: (e: React.DragEvent) => {
      setDropTarget(null)
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      if (!raw) return
      e.preventDefault()
      try { void move(JSON.parse(raw) as string[], folderId) } catch { /* foreign payload */ }
    },
  })
  const dropRing = (key: string) => (dropTarget === key ? 'ring-2 ring-primary bg-primary/10' : '')

  const link = (v: View, label: React.ReactNode, icon: React.ReactNode, opts: { sub?: boolean; hot?: boolean; drop?: string | null } = {}) => {
    const on = isOn(v)
    const key = v.kind === 'folder' ? `f:${v.id}` : v.kind
    return (
      <Link
        key={key}
        href={viewHref(v)}
        aria-current={on ? 'page' : undefined}
        className={`${item} ${on ? active : idle} ${opts.sub ? 'py-1.5 pl-11 text-[13px]' : ''} ${opts.drop !== undefined ? dropRing(key) : ''}`}
        {...(opts.drop !== undefined ? dropProps(key, opts.drop) : {})}
      >
        {icon}
        <span className="truncate">{label}</span>
        <Count n={countIn(projects, v)} hot={opts.hot} on={on} />
      </Link>
    )
  }

  return (
    <>
      {link({ kind: 'all' }, projectsLabel, projectsIcon)}
      {link({ kind: 'feedback' }, t('viewFeedback'), null, { sub: true, hot: true })}
      {link({ kind: 'review' }, t('viewReview'), null, { sub: true })}

      <div className="flex items-center px-3 pb-1 pt-4 text-xs font-semibold text-muted-foreground">
        {t('folders')}
        <button type="button" onClick={() => setCreating(true)} className="ml-auto rounded p-1 hover:bg-accent hover:text-foreground" aria-label={t('newFolder')} title={t('newFolder')}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {folders.map((f) => link({ kind: 'folder', id: f.id }, f.name, <Folder className="h-4 w-4 shrink-0" />, { drop: f.id }))}
      {link({ kind: 'nofolder' }, t('noFolder'), <span className="w-4 shrink-0" />, { drop: null })}
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
