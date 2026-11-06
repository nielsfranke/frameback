'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import {
  AlertTriangle, Archive, BarChart3, Check, ChevronDown, ChevronUp, Clock, Download, GripVertical, Images, Loader2,
  MessageSquare, MoreHorizontal, Pencil, Send, Settings, Trash2, Undo2, Upload, Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import VideoList from '@/components/VideoList'
import { VideoUploadModal } from '@/components/VideoUploadModal'
import PhotoAlbumsBlock from '@/components/PhotoAlbumsBlock'
import ProjectUploadsBlock from '@/components/ProjectUploadsBlock'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { logError } from '@/lib/logging'
import { Menu } from '../Menu'
import { useToast } from '../Toast'
import { useStudioData } from '../StudioData'
import { useStudioActions } from '../useStudioActions'
import { buildGroups, openThreads, unreadIn, type AdminComment, type AdminVideo, type Group } from './groups'
import { useSortable } from './useSortable'
import { NewVersionDialog, RenameVideoDialog, SendForReviewDialog, SharePopover } from './Dialogs'
import type { ActivityItem } from '@/lib/studio-feedback'

const chip: Record<Group['state'], string> = {
  draft: 'bg-muted text-muted-foreground',
  waiting: 'bg-primary/10 text-primary',
  changes: 'bg-warning/15 text-warning',
  approved: 'bg-success/15 text-success',
}

export default function StudioProjectPage({ id }: { id: string }) {
  const t = useTranslations('studio.project')
  const ts = useTranslations('studio')
  const tr = useTranslations('review')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const router = useRouter()
  const toast = useToast()
  const { reload: reloadOverview } = useStudioData()
  const { archive } = useStudioActions()

  const [project, setProject] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [shareUrl, setShareUrl] = useState('')
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sending, setSending] = useState<Group | null>(null)
  const [newVersion, setNewVersion] = useState<{ group: Group; file?: File | null } | null>(null)
  const [renaming, setRenaming] = useState<Group | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [dropped, setDropped] = useState<File[]>([])
  const [dropRow, setDropRow] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const sessionId = `studio-project:${id}`

  const fetchProject = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/projects/${id}`)
      if (res.status === 404) { router.push('/admin/projects'); return }
      if (!res.ok) throw new Error(String(res.status))
      setProject(await res.json())
    } catch (e) {
      logError('Error fetching project:', e)
    } finally {
      setLoading(false)
    }
  }, [id, router])

  const fetchFeedback = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/studio/projects/${id}/feedback`, { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json()
      setUnread(new Set(d.unreadIds))
      setActivity(d.activity)
    } catch { /* non-critical */ }
  }, [id])

  const refresh = useCallback(async () => { await Promise.all([fetchProject(), fetchFeedback()]); void reloadOverview() }, [fetchProject, fetchFeedback, reloadOverview])

  useEffect(() => { void fetchProject(); void fetchFeedback() }, [fetchProject, fetchFeedback])
  useEffect(() => {
    const h = () => void refresh()
    window.addEventListener('videoApprovalChanged', h)
    window.addEventListener('commentDeleted', h)
    return () => { window.removeEventListener('videoApprovalChanged', h); window.removeEventListener('commentDeleted', h) }
  }, [refresh])
  // poll while something is processing
  useEffect(() => {
    if (!project?.videos?.some((v: AdminVideo) => v.status === 'PROCESSING' || v.status === 'UPLOADING')) return
    const iv = setInterval(() => void fetchProject(), 5000)
    return () => clearInterval(iv)
  }, [project?.videos, fetchProject])
  useEffect(() => {
    if (!project?.slug) return
    apiFetch(`/api/share/url?slug=${project.slug}`).then((r) => (r.ok ? r.json() : null)).then((d) => d && setShareUrl(d.shareUrl)).catch(() => {})
  }, [project?.slug])

  const groups = useMemo(() => buildGroups((project?.videos ?? []) as AdminVideo[]), [project?.videos])
  const comments = (project?.comments ?? []) as AdminComment[]

  // one thumbnail per group (current version, else newest with a thumbnail)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(groups.map(async (g) => {
        const v = [g.current, ...g.versions].find((x) => x?.thumbnailPath)
        if (!v) return null
        try {
          const r = await apiFetch(`/api/admin/video-token?videoId=${v.id}&projectId=${id}&quality=thumbnail&sessionId=${sessionId}`, { cache: 'no-store' })
          const d = r.ok ? await r.json() : null
          return d?.token ? ([g.groupId, `/api/content/${d.token}`] as const) : null
        } catch { return null }
      }))
      if (!cancelled) setThumbs(Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, string]>))
    })()
    return () => { cancelled = true }
  }, [groups, id, sessionId])

  const saveOrder = useCallback(async (groupIds: string[]) => {
    const res = await apiFetch(`/api/projects/${id}/video-order`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupIds }) })
    return res.ok ? 'ok' : res.status === 409 ? 'conflict' : 'error'
  }, [id])

  const applyOrder = useCallback((ids: string[]) => {
    setProject((p: any) => p && {
      ...p,
      videos: p.videos.map((v: AdminVideo) => ({ ...v, group: { ...(v.group ?? {}), sortOrder: ids.indexOf(v.groupId) + 1 } })),
    })
  }, [])

  // one order write at a time: sorting is locked until the server has answered
  const [savingOrder, setSavingOrder] = useState(false)
  const sortable = useSortable(
    groups.map((g) => g.groupId),
    async (next, prev) => {
      applyOrder(next) // optimistic
      setSavingOrder(true)
      const r = await saveOrder(next)
      setSavingOrder(false)
      if (r !== 'ok') {
        applyOrder(prev)
        toast(r === 'conflict' ? t('orderConflict') : ts('actionFailed'))
        if (r === 'conflict') void fetchProject()
        return
      }
      toast(t('orderSaved'), async () => {
        setSavingOrder(true)
        const u = await saveOrder(prev)
        setSavingOrder(false)
        if (u === 'ok') { applyOrder(prev); toast(ts('undone')) } else { toast(ts('actionFailed')); void fetchProject() }
      })
    },
    setLive,
    {
      picked: (pos, total) => t('dndPicked', { pos, total }),
      moved: (pos, total) => t('dndMoved', { pos, total }),
      dropped: (pos) => t('dndDropped', { pos }),
      cancelled: t('dndCancelled'),
    },
  )
  const ordered = sortable.order.map((gid) => groups.find((g) => g.groupId === gid)).filter(Boolean) as Group[]

  if (loading) return <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
  if (!project) return <div className="p-8 text-muted-foreground">{t('notFound')}</div>

  const summary = {
    total: groups.length,
    approved: groups.filter((g) => g.state === 'approved').length,
    changes: groups.filter((g) => g.state === 'changes').length,
    waiting: groups.filter((g) => g.state === 'waiting').length,
    draft: groups.filter((g) => g.state === 'draft').length,
    unread: unread.size,
  }
  const clientLabel = project.clientCompany?.name || project.companyName || null

  const deleteGroup = async (g: Group) => {
    if (!window.confirm(t('deleteVideoConfirm', { name: g.name }))) return
    let removed = 0
    try {
      for (const v of g.versions) { await apiDelete(`/api/videos/${v.id}`); removed++ }
      toast(t('videoDeleted'))
    } catch {
      toast(removed ? t('deletePartial', { done: removed, total: g.versions.length }) : ts('actionFailed'))
    } finally {
      void refresh()
    }
  }
  const withdraw = async (g: Group) => {
    if (!g.current) return
    try { await apiDelete(`/api/videos/${g.current.id}/review-request`); toast(t('withdrawn')); void refresh() } catch { toast(ts('actionFailed')) }
  }
  const downloadOriginal = async (g: Group) => {
    if (!g.current) return
    try {
      const r = await apiFetch(`/api/videos/${g.current.id}/download-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const d = r.ok ? await r.json() : null
      if (d?.url) window.location.href = d.url; else toast(ts('actionFailed'))
    } catch { toast(ts('actionFailed')) }
  }
  const deleteProject = async () => {
    const typed = window.prompt(t('deleteProjectPrompt', { title: project.title }))
    if (typed === null) return
    if (typed.trim() !== project.title.trim()) { toast(t('deleteProjectMismatch')); return }
    try { await apiDelete(`/api/projects/${project.id}`); await reloadOverview(); router.push('/admin/projects') } catch { toast(ts('actionFailed')) }
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-5 sm:px-7">
      <nav className="text-[13px] text-muted-foreground" aria-label={t('breadcrumb')}>
        <Link href="/admin/projects" className="hover:text-foreground">{ts('viewTitle.all')}</Link>
        {project.folder && <> <span aria-hidden>/</span> <Link href={`/admin/projects?folder=${project.folder.id}`} className="hover:text-foreground">{project.folder.name}</Link></>}
      </nav>

      <header className="mb-5 mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight tracking-tight [text-wrap:balance]">{project.title}</h1>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            {clientLabel && <b className="font-semibold text-foreground">{clientLabel}</b>}
            <span>{project.authMode === 'NONE' ? t('accessOpen') : t('accessProtected')}</span>
            <Link href={`/admin/projects/${id}/settings`} className="hover:text-foreground hover:underline" title={project.reviewFlow ? tr('projectSettingOn') : tr('projectSettingOff')}>{project.reviewFlow ? tr('accessOn') : tr('accessOff')}</Link>
            {project.dueDate && <span>{ts('due', { date: format.dateTime(new Date(project.dueDate), { day: 'numeric', month: 'short' }) })}</span>}
          </div>
          {summary.total > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <span className="inline-flex items-center gap-1.5"><i className="h-[7px] w-[7px] rounded-full bg-success" /><b>{summary.approved}/{summary.total}</b> {t('approvedWord')}</span>
              {summary.changes > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-[7px] w-[7px] rounded-full bg-warning" />{t('changesN', { n: summary.changes })}</span>}
              {summary.waiting > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-[7px] w-[7px] rounded-full bg-primary" />{t('waitingN', { n: summary.waiting })}</span>}
              {summary.draft > 0 && <span className="inline-flex items-center gap-1.5 text-muted-foreground"><i className="h-[7px] w-[7px] rounded-full bg-muted-foreground" />{t('draftN', { n: summary.draft })}</span>}
              {summary.unread > 0 && <b>{t('unreadN', { n: summary.unread })}</b>}
            </div>
          )}
        </div>
        <div className="flex flex-none gap-2 sm:ml-auto">
          <SharePopover project={project} shareUrl={shareUrl} />
          <Button onClick={() => { setDropped([]); setUploadOpen(true) }} className="flex-1 sm:flex-none"><Upload className="mr-1.5 h-4 w-4" />{t('upload')}</Button>
          <Menu
            label={t('projectMenu')}
            trigger={<MoreHorizontal className="h-4 w-4" />}
            items={[
              { label: t('settings'), icon: <Settings className="h-4 w-4" />, onSelect: () => router.push(`/admin/projects/${id}/settings`) },
              { label: t('analytics'), icon: <BarChart3 className="h-4 w-4" />, onSelect: () => router.push(`/admin/projects/${id}/analytics`) },
              { label: ts('archiveAction'), icon: <Archive className="h-4 w-4" />, separatorBefore: true, onSelect: async () => { await archive([id]); void fetchProject() } },
              { label: t('deleteProject'), icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: deleteProject },
            ]}
          />
        </div>
      </header>

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section aria-labelledby="fb-videos">
          <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3">
            <h2 id="fb-videos" className="text-[15px] font-semibold">{t('videos')}</h2>
            <span id="fb-dnd-help" className="text-xs text-muted-foreground">{t('dndHint')}</span>
          </div>
          <div className="sr-only" aria-live="assertive">{live}</div>

          {groups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">{t('noVideos')}</div>
          ) : (
            <ol className="overflow-hidden rounded-xl border border-border bg-card shadow-elevation-sm">
              {ordered.map((g, i) => {
                const open = openThreads(comments, g)
                const fresh = unreadIn(comments, g, unread)
                const cur = g.current
                const isActive = sortable.active === g.groupId
                const reviewHref = `/admin/projects/${id}/review?video=${encodeURIComponent(g.groupId)}`
                const primary = g.state === 'changes' || fresh > 0
                  ? <Button asChild size="sm"><Link href={reviewHref}><MessageSquare className="mr-1.5 h-4 w-4" />{fresh ? t('feedbackNew', { n: fresh }) : t('feedback')}</Link></Button>
                  : g.state === 'draft' && cur
                    ? <Button size="sm" onClick={() => setSending(g)}><Send className="mr-1.5 h-4 w-4" />{t('sendForApproval')}</Button>
                    : <Button asChild size="sm" variant="outline"><Link href={reviewHref}>{t('view')}</Link></Button>
                return (
                  <li
                    key={g.groupId}
                    ref={sortable.register(g.groupId)}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropRow(g.groupId) } }}
                    onDragLeave={() => setDropRow((d) => (d === g.groupId ? null : d))}
                    onDrop={(e) => {
                      const f = e.dataTransfer.files?.[0]
                      setDropRow(null)
                      if (!f) return
                      e.preventDefault()
                      setNewVersion({ group: g, file: f })
                    }}
                    className={`relative border-t border-border first:border-t-0 ${isActive ? 'z-10 bg-card shadow-elevation-lg ring-2 ring-primary' : ''} ${dropRow === g.groupId ? 'bg-primary/5 ring-2 ring-inset ring-primary' : ''}`}
                  >
                    <div className="grid grid-cols-[30px_92px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-2 py-3 sm:grid-cols-[30px_112px_minmax(0,1fr)_auto] sm:pr-4">
                      <button
                        type="button"
                        onPointerDown={savingOrder ? undefined : sortable.onPointerDown(g.groupId)}
                        onKeyDown={savingOrder ? undefined : sortable.onKeyDown(g.groupId)}
                        aria-disabled={savingOrder}
                        aria-label={t('dndHandle', { pos: i + 1, name: g.name })}
                        aria-describedby="fb-dnd-help"
                        aria-pressed={sortable.mode === 'keyboard' && isActive}
                        className="flex h-[52px] w-[30px] touch-none cursor-grab flex-col items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
                      >
                        <span className="text-[13px] font-semibold tabular-nums leading-4">{i + 1}</span>
                        <GripVertical className="h-3.5 w-3.5 opacity-60" />
                      </button>
                      <Link href={reviewHref} className="relative block aspect-video w-[92px] overflow-hidden rounded-md bg-muted sm:w-[112px]" aria-label={t('openVideo', { name: g.name })}>
                        {thumbs[g.groupId]
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={thumbs[g.groupId]} alt="" className="h-full w-full object-cover" />
                          : <span className="flex h-full items-center justify-center text-muted-foreground"><Video className="h-5 w-5" /></span>}
                        {cur?.duration ? <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[11px] font-semibold tabular-nums text-white">{Math.floor(cur.duration / 60)}:{String(Math.floor(cur.duration % 60)).padStart(2, '0')}</span> : null}
                      </Link>
                      <div className="min-w-0">
                        <button type="button" onClick={() => setExpanded((x) => (x === g.groupId ? null : g.groupId))} aria-expanded={expanded === g.groupId} className="line-clamp-2 text-left text-[14.5px] font-semibold leading-snug hover:text-primary">
                          {g.name}
                        </button>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
                          {cur ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${chip[g.state]}`}>{t(`state.${g.state}`)}</span>
                            : g.pending?.status === 'ERROR' ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">{t('failed')}</span>
                              : <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">{t('processing')}</span>}
                          {cur && <span className="tabular-nums">v{cur.version} · {format.dateTime(new Date(cur.createdAt), { day: '2-digit', month: '2-digit' })}</span>}
                          {g.pending && cur && <span className={g.pending.status === 'ERROR' ? 'text-destructive' : 'text-foreground'}>{g.pending.status === 'ERROR' ? t('pendingError', { version: g.pending.version }) : t('pending', { version: g.pending.version, current: cur ? `v${cur.version}` : '–' })}</span>}
                          {(open > 0 || fresh > 0) && (
                            <span className="inline-flex items-center gap-1 font-medium text-foreground">
                              <MessageSquare className="h-3.5 w-3.5" />{t('openN', { n: open })}
                              {fresh > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-bold leading-[17px] text-primary-foreground">{t('newN', { n: fresh })}</span>}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="col-span-2 col-start-2 flex items-center gap-1.5 sm:col-span-1 sm:col-start-auto">
                        {primary}
                        <Button size="sm" variant="outline" onClick={() => setNewVersion({ group: g })}><Upload className="mr-1.5 h-4 w-4" /><span className="hidden md:inline">{t('newVersion')}</span><span className="md:hidden">{t('newVersionShort')}</span></Button>
                        <Menu
                          label={t('videoMenu', { name: g.name })}
                          trigger={<MoreHorizontal className="h-4 w-4" />}
                          items={[
                            ...(g.state === 'waiting' ? [{ label: t('withdraw'), icon: <Undo2 className="h-4 w-4" />, onSelect: () => withdraw(g) }] : []),
                            ...((g.state === 'changes' || (g.state === 'draft' && fresh > 0)) && cur ? [{ label: t('sendForApproval'), icon: <Send className="h-4 w-4" />, onSelect: () => setSending(g) }] : []),
                            { label: t('rename'), icon: <Pencil className="h-4 w-4" />, onSelect: () => setRenaming(g) },
                            { label: t('versionsAndFiles'), icon: expanded === g.groupId ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />, onSelect: () => setExpanded((x) => (x === g.groupId ? null : g.groupId)) },
                            ...(cur ? [{ label: t('downloadOriginal'), icon: <Download className="h-4 w-4" />, onSelect: () => downloadOriginal(g) }] : []),
                            { label: t('deleteVideo'), icon: <Trash2 className="h-4 w-4" />, danger: true, separatorBefore: true, onSelect: () => deleteGroup(g) },
                          ]}
                        />
                      </div>
                    </div>
                    {expanded === g.groupId && (
                      <div className="border-t border-border bg-background/40 px-3 py-3 sm:pl-[54px]">
                        <VideoList videos={g.versions as any} onRefresh={() => void refresh()} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}

          <button
            type="button"
            onClick={() => { setDropped([]); setUploadOpen(true) }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
            onDrop={(e) => { const files = [...(e.dataTransfer.files ?? [])]; if (!files.length) return; e.preventDefault(); setDropped(files); setUploadOpen(true) }}
            className="mt-3 flex w-full items-center gap-3 rounded-xl border-[1.5px] border-dashed border-border px-4 py-4 text-left text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-foreground"
          >
            <Upload className="h-4 w-4 flex-none" />
            <span><b className="font-semibold text-foreground">{t('addVideos')}</b> <span className="hidden sm:inline">– {t('addVideosHint')}</span></span>
          </button>

          <details className="mt-6 rounded-xl border border-border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-semibold"><Images className="h-4 w-4" />{t('photos')}<ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" /></summary>
            <div className="border-t border-border p-3"><PhotoAlbumsBlock projectId={id} sortMode="date" onCountsChange={() => {}} /></div>
          </details>
          <details className="mt-3 rounded-xl border border-border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-semibold"><Download className="h-4 w-4" />{t('clientUploads')}<ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" /></summary>
            <div className="border-t border-border p-3"><ProjectUploadsBlock projectId={id} onCountChange={() => {}} /></div>
          </details>
        </section>

        <aside aria-labelledby="fb-activity" className="lg:sticky lg:top-5">
          <h2 id="fb-activity" className="mb-2 text-[13px] font-semibold text-muted-foreground">{t('activity')}</h2>
          {activity.length === 0 ? <p className="text-sm text-muted-foreground">{t('noActivity')}</p> : (
            <ul className="space-y-3">
              {activity.map((a, i) => {
                const [Icon, tone] = a.type === 'upload' ? [Upload, 'bg-muted text-muted-foreground']
                  : a.type === 'comments' ? [MessageSquare, 'bg-primary/10 text-primary']
                    : a.kind === 'APPROVE' || a.kind === 'ADMIN_OVERRIDE' ? [Check, 'bg-success/15 text-success']
                      : a.kind === 'REQUEST_CHANGES' ? [AlertTriangle, 'bg-warning/15 text-warning']
                        : [a.kind === 'SENT_FOR_REVIEW' ? Send : Clock, 'bg-primary/10 text-primary']
                const actor = (s: string) => <b className="font-semibold">{s || ts('someone')}</b>
                const text = a.type === 'upload' ? t('actUpload', { video: a.video, version: a.version })
                  : a.type === 'comments' ? t.rich('actComments', { actor: () => actor(a.actor), n: a.count, video: a.video })
                    : t.rich(`actDecision.${a.kind}`, { actor: () => actor(a.actor), video: a.video, version: a.version })
                return (
                  <li key={i} className="grid grid-cols-[22px_1fr] gap-2.5 text-[13px] leading-snug">
                    <span className={`mt-0.5 grid h-[22px] w-[22px] place-items-center rounded-full ${tone}`}><Icon className="h-3 w-3" /></span>
                    <span>{text}<time className="block text-xs text-muted-foreground" dateTime={a.at}>{format.relativeTime(new Date(a.at), now)}</time></span>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>
      </div>

      <VideoUploadModal isOpen={uploadOpen} onClose={() => { setUploadOpen(false); setDropped([]) }} projectId={id} initialFiles={dropped} onUploadComplete={() => void refresh()} />
      <SendForReviewDialog group={sending} smtpConfigured={!!project.smtpConfigured} onOpenChange={(o) => { if (!o) setSending(null) }} onDone={() => void refresh()} />
      <NewVersionDialog projectId={id} group={newVersion?.group ?? null} file={newVersion?.file} onOpenChange={(o) => { if (!o) setNewVersion(null) }} onUploaded={() => void refresh()} />
      <RenameVideoDialog group={renaming} onOpenChange={(o) => { if (!o) setRenaming(null) }} onDone={() => void refresh()} />
    </div>
  )
}
