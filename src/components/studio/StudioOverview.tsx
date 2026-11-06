'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Archive, ArchiveRestore, Eye, Folder, FolderInput, Link2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, Video, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStudioData } from './StudioData'
import { useStudioActions } from './useStudioActions'
import { useToast } from './Toast'
import { Menu } from './Menu'
import { FolderNameDialog, MoveDialog } from './FolderDialogs'
import { rememberView } from './StudioNav'
import { clientName, DRAG_TYPE, inView, matchesQuery, viewFromParams, type StudioProject, type View } from './views'

type Sort = 'activity' | 'name' | 'due'

function Progress({ p }: { p: StudioProject }) {
  const t = useTranslations('studio')
  if (p.videos === 0) return <span className="text-[12.5px] text-muted-foreground">{t('noVideos')}</span>
  const seg = (n: number, cls: string) => (n ? <i className={`block ${cls}`} style={{ width: `${(n / p.videos) * 100}%` }} /> : null)
  const parts = [t('approvedOf', { done: p.approved, total: p.videos })]
  if (p.changes) parts.push(t('withChanges', { n: p.changes }))
  if (p.waiting) parts.push(t('waitingN', { n: p.waiting }))
  return (
    <div className="text-[12.5px]">
      <span className="tabular-nums">{parts.join(' · ')}</span>
      <div className="mt-1.5 flex h-[5px] max-w-[160px] overflow-hidden rounded-full bg-muted" aria-hidden>
        {seg(p.approved, 'bg-success')}{seg(p.changes, 'bg-warning')}{seg(p.waiting, 'bg-primary')}
      </div>
    </div>
  )
}

function LastActivity({ p }: { p: StudioProject }) {
  const t = useTranslations('studio')
  const format = useFormatter()
  const a = p.last
  if (!a) return null
  const who = (s: string) => <b className="font-medium text-foreground">{s || t('someone')}</b>
  let text: React.ReactNode
  switch (a.type) {
    case 'comment': text = t.rich(a.count > 1 ? 'lastComments' : 'lastComment', { actor: () => who(a.actor), n: a.count }); break
    case 'decision': text = t.rich(`lastDecision.${a.kind}`, { actor: () => who(a.actor) }); break
    case 'upload': text = t('lastUpload', { video: a.video, version: a.version }); break
    default: text = t('lastCreated')
  }
  return (
    <div className="text-[12.5px] leading-snug text-muted-foreground">
      <div className="line-clamp-2">
        {p.unread > 0 && <span className="mr-1.5 inline-block rounded-full bg-primary px-1.5 text-[11px] font-bold leading-[17px] text-primary-foreground">{t('newN', { n: p.unread })}</span>}
        {text}
      </div>
      <time dateTime={a.at}>{format.relativeTime(new Date(a.at))}</time>
    </div>
  )
}

function Row({ p, view, selected, selection, onToggle, onMove }: {
  p: StudioProject
  view: View
  selected: boolean
  selection: string[]
  onToggle: () => void
  onMove: (ids: string[]) => void
}) {
  const t = useTranslations('studio')
  const format = useFormatter()
  const router = useRouter()
  const toast = useToast()
  const { archive, restore } = useStudioActions()
  const href = `/admin/projects/${p.id}`
  const client = clientName(p)
  const open = () => { rememberView(view); router.push(href) }
  return (
    <div
      role="row"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(selected ? selection : [p.id]))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button,input')) open() }}
      className={`grid cursor-pointer grid-cols-[22px_72px_minmax(0,1fr)_32px] items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2.5 first:border-t-0 hover:bg-background/50 md:grid-cols-[22px_88px_minmax(0,1fr)_200px_32px] xl:grid-cols-[22px_88px_minmax(0,1fr)_210px_250px_32px] ${selected ? 'bg-primary/10' : ''}`}
    >
      <input type="checkbox" checked={selected} onChange={onToggle} aria-label={t('selectProject', { title: p.title })} className="h-4 w-4 cursor-pointer accent-primary" />
      <div className="aspect-video w-[72px] overflow-hidden rounded-md bg-muted md:w-[88px]">
        {p.thumbnailUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={p.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          : <div className="flex h-full items-center justify-center text-muted-foreground"><Video className="h-4 w-4" /></div>}
      </div>
      <div className="min-w-0">
        <Link href={href} onClick={() => rememberView(view)} className="line-clamp-2 font-semibold leading-snug hover:text-primary">
          {p.unread > 0 && <span className="mr-1.5 inline-block rounded-full bg-primary px-1.5 align-[1px] text-[11px] font-bold leading-[17px] text-primary-foreground xl:hidden">{t('newN', { n: p.unread })}</span>}
          {p.title}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[12.5px] text-muted-foreground">
          <span>{client ?? t('noClient')}</span>
          {p.folder && view.kind !== 'folder' && p.folder.name !== client && <span className="inline-flex items-center gap-1"><Folder className="h-3 w-3" />{p.folder.name}</span>}
          {p.dueDate && <span>{t('due', { date: format.dateTime(new Date(p.dueDate), { day: 'numeric', month: 'short' }) })}</span>}
          {p.archived && <span className="rounded bg-muted px-1.5 text-[11px] font-semibold">{t('archivedBadge')}</span>}
        </div>
        <div className="mt-1.5 md:hidden"><Progress p={p} /></div>
      </div>
      <div className="hidden md:block"><Progress p={p} /></div>
      <div className="hidden xl:block"><LastActivity p={p} /></div>
      <Menu
        label={t('projectActions', { title: p.title })}
        trigger={<MoreHorizontal className="h-4 w-4" />}
        items={[
          { label: t('open'), icon: <Eye className="h-4 w-4" />, onSelect: open },
          { label: t('moveTo'), icon: <FolderInput className="h-4 w-4" />, onSelect: () => onMove([p.id]) },
          { label: t('copyLink'), icon: <Link2 className="h-4 w-4" />, onSelect: async () => {
            try { await navigator.clipboard.writeText(`${window.location.origin}/share/${p.slug}`); toast(t('linkCopied')) } catch { toast(t('actionFailed')) }
          } },
          p.archived
            ? { label: t('restore'), icon: <ArchiveRestore className="h-4 w-4" />, onSelect: () => restore([p.id]), separatorBefore: true }
            : { label: t('archiveAction'), icon: <Archive className="h-4 w-4" />, onSelect: () => archive([p.id]), separatorBefore: true },
        ]}
      />
    </div>
  )
}

function Inner() {
  const t = useTranslations('studio')
  const sp = useSearchParams()
  const router = useRouter()
  const view = viewFromParams(sp)
  const { projects, folders, loading, error, reload } = useStudioData()
  const { archive, restore, renameFolder, deleteFolder } = useStudioActions()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('activity')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState<string[] | null>(null)
  const [renaming, setRenaming] = useState(false)
  const viewKey = JSON.stringify(view)
  // a selection never outlives the list it was made in
  useEffect(() => { setSel(new Set()) }, [viewKey, q])

  const folder = view.kind === 'folder' ? folders.find((f) => f.id === view.id) : null
  const title = q.trim() ? t('searchResults')
    : view.kind === 'folder' ? folder?.name ?? '' : t(`viewTitle.${view.kind}`)

  const list = useMemo(() => {
    const rows = q.trim() ? projects.filter((p) => matchesQuery(p, q)) : projects.filter((p) => inView(p, view))
    const by: Record<Sort, (a: StudioProject, b: StudioProject) => number> = {
      activity: (a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || +new Date(b.last?.at ?? b.createdAt) - +new Date(a.last?.at ?? a.createdAt),
      name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
      due: (a, b) => (a.dueDate ? +new Date(a.dueDate) : Infinity) - (b.dueDate ? +new Date(b.dueDate) : Infinity),
    }
    return [...rows].sort(by[sort])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, viewKey, q, sort])

  const selection = list.filter((p) => sel.has(p.id)).map((p) => p.id)
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allSelected = list.length > 0 && selection.length === list.length
  const archiveView = view.kind === 'archive'

  if (view.kind === 'folder' && !loading && !folder) {
    return <div className="p-8 text-sm text-muted-foreground">{t('folderMissing')} <Link className="text-primary underline" href="/admin/projects">{t('viewTitle.all')}</Link></div>
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-5 sm:px-7">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        <span className="text-muted-foreground tabular-nums">{list.length}</span>
        {folder && (
          <Menu
            align="left"
            label={t('folderActions')}
            trigger={<MoreHorizontal className="h-4 w-4" />}
            items={[
              { label: t('renameFolder'), icon: <Pencil className="h-4 w-4" />, onSelect: () => setRenaming(true) },
              { label: t('deleteFolder'), icon: <Trash2 className="h-4 w-4" />, danger: true, separatorBefore: true, onSelect: async () => {
                if (!window.confirm(t('deleteFolderConfirm', { name: folder.name }))) return
                if (await deleteFolder(folder.id)) router.push('/admin/projects?folder=none')
              } },
            ]}
          />
        )}
        <Button asChild className="ml-auto"><Link href="/admin/projects/new"><Plus className="mr-1.5 h-4 w-4" />{t('newProject')}</Link></Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchAll')} aria-label={t('searchAll')} className="pl-9" />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('sort')} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
          <option value="activity">{t('sortActivity')}</option>
          <option value="name">{t('sortName')}</option>
          <option value="due">{t('sortDue')}</option>
        </select>
      </div>
      {q.trim() && <p className="mb-2 text-xs font-semibold text-muted-foreground">{t('searchScope')}</p>}

      {error ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm">
          {t('loadFailed')} <Button variant="outline" size="sm" className="ml-2" onClick={() => reload()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('retry')}</Button>
        </div>
      ) : loading ? (
        <div className="rounded-xl border border-border bg-card" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex items-center gap-3 border-t border-border px-3 py-3 first:border-t-0"><div className="h-4 w-4 rounded bg-muted" /><div className="aspect-video w-[88px] rounded-md bg-muted" /><div className="h-4 w-1/3 rounded bg-muted" /></div>)}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          {q.trim() ? t('emptySearch') : t(`empty.${view.kind}`)}
        </div>
      ) : (
        <div role="table" aria-label={title} className="overflow-hidden rounded-xl border border-border bg-card shadow-elevation-sm">
          <div role="row" className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(list.map((p) => p.id)))} aria-label={t('selectAll')} className="h-4 w-4 cursor-pointer accent-primary" />
            <span>{selection.length ? t('selectedN', { n: selection.length }) : t('selectHint')}</span>
          </div>
          {list.map((p) => (
            <Row key={p.id} p={p} view={view} selected={sel.has(p.id)} selection={selection} onToggle={() => toggle(p.id)} onMove={setMoving} />
          ))}
        </div>
      )}

      {selection.length > 0 && (
        <div role="region" aria-label={t('selection')} className="sticky bottom-4 z-30 mx-auto mt-3 flex w-max max-w-full flex-wrap items-center gap-2 rounded-xl bg-neutral-900 py-2 pl-4 pr-2 text-sm text-white shadow-elevation-lg animate-in fade-in slide-in-from-bottom-2">
          <span><b>{selection.length}</b> {t('selected')}</span>
          <Button size="sm" variant="secondary" onClick={() => setMoving(selection)}><FolderInput className="mr-1.5 h-4 w-4" />{t('moveTo')}</Button>
          {archiveView
            ? <Button size="sm" variant="secondary" onClick={async () => { await restore(selection); setSel(new Set()) }}><ArchiveRestore className="mr-1.5 h-4 w-4" />{t('restore')}</Button>
            : <Button size="sm" variant="secondary" onClick={async () => { await archive(selection); setSel(new Set()) }}><Archive className="mr-1.5 h-4 w-4" />{t('archiveAction')}</Button>}
          <button type="button" onClick={() => setSel(new Set())} aria-label={t('clearSelection')} className="rounded-md p-1.5 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      )}

      <MoveDialog
        projectIds={moving}
        titleText={moving && moving.length === 1 ? t('moveOneTitle', { title: projects.find((p) => p.id === moving[0])?.title ?? '' }) : t('moveManyTitle', { n: moving?.length ?? 0 })}
        onOpenChange={(o) => { if (!o) setMoving(null) }}
        onDone={() => setSel(new Set())}
      />
      {folder && <FolderNameDialog open={renaming} onOpenChange={setRenaming} initial={folder.name} title={t('renameFolder')} onSubmit={(name) => renameFolder(folder.id, name)} />}
    </div>
  )
}

/** Project overview for FEATURE_STUDIO_V2 (views and folders come from the sidebar). */
export default function StudioOverview() {
  return <Suspense fallback={null}><Inner /></Suspense>
}
