'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import DOMPurify from 'isomorphic-dompurify'
import { AlertTriangle, Check, ChevronDown, ChevronLeft, Clock, CornerUpLeft, Loader2, RotateCcw, Send, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import Player, { type Marker, type PlayerHandle } from '@/components/frameback-share/Player'
import { formatSeconds, initials } from '@/components/frameback-share/api'
import { apiFetch, apiPost } from '@/lib/api-client'
import { secondsToTimecode, timecodeToSeconds } from '@/lib/timecode'
import { useToast } from '../Toast'
import { useStudioData } from '../StudioData'
import { buildGroups, type AdminVideo, type Group } from '../project/groups'
import { NewVersionDialog, SendForReviewDialog } from '../project/Dialogs'

interface C {
  id: string
  videoId: string
  parentId?: string | null
  timecode: string
  content: string
  authorName?: string | null
  isInternal: boolean
  userId?: string | null
  deleted?: boolean
  resolvedAt?: string | null
  createdAt: string
  replies?: C[]
}

const safeHtml = (html: string) => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i,
  FORCE_BODY: true,
})
const isClient = (c: C) => !c.isInternal && !c.userId
const palette = ['#7c3aed', '#0d9488', '#db2777', '#ea580c', '#2563eb', '#16a34a']
const colorFor = (name: string) => palette[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % palette.length]

type Filter = 'open' | 'done' | 'all'

export default function StudioReview({ projectId }: { projectId: string }) {
  const t = useTranslations('studio.review')
  const tp = useTranslations('studio.project')
  const ts = useTranslations('studio')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const sp = useSearchParams()
  const router = useRouter()
  const toast = useToast()
  const { reload: reloadOverview } = useStudioData()
  const player = useRef<PlayerHandle>(null)

  const [project, setProject] = useState<any>(null)
  const [comments, setComments] = useState<C[]>([])
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [urls, setUrls] = useState<{ stream: string; poster: string | null } | null>(null)
  const [filter, setFilter] = useState<Filter | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pinned, setPinned] = useState<number | null>(null)
  const [time, setTime] = useState(0)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<'video' | 'version' | null>(null)
  const [sending, setSending] = useState<Group | null>(null)
  const [newVersion, setNewVersion] = useState<Group | null>(null)

  const loadProject = useCallback(async () => {
    const r = await apiFetch(`/api/projects/${projectId}`)
    if (r.status === 404) { router.push('/admin/projects'); return }
    if (r.ok) setProject(await r.json())
  }, [projectId, router])
  const loadComments = useCallback(async () => {
    const r = await apiFetch(`/api/comments?projectId=${projectId}`, { cache: 'no-store' })
    if (r.ok) setComments(await r.json())
  }, [projectId])
  const loadUnread = useCallback(async () => {
    const r = await apiFetch(`/api/studio/projects/${projectId}/feedback`, { cache: 'no-store' })
    if (r.ok) setUnread(new Set((await r.json()).unreadIds))
  }, [projectId])
  useEffect(() => { void loadProject(); void loadComments(); void loadUnread() }, [loadProject, loadComments, loadUnread])
  useEffect(() => {
    if (!project?.videos?.some((v: AdminVideo) => v.status === 'PROCESSING' || v.status === 'UPLOADING')) return
    const iv = setInterval(() => void loadProject(), 5000)
    return () => clearInterval(iv)
  }, [project?.videos, loadProject])

  const groups = useMemo(() => buildGroups((project?.videos ?? []) as AdminVideo[]), [project?.videos])
  const group = groups.find((g) => g.groupId === sp?.get('video')) ?? groups[0]
  const readyVersions = group?.versions.filter((v) => v.status === 'READY') ?? []
  const wanted = Number(sp?.get('v'))
  const video = readyVersions.find((v) => v.version === wanted) ?? group?.current ?? null
  const isOld = !!video && !!group?.current && video.version < group.current.version
  const fps = video?.fps || 24
  // a draft belongs to the video version it was written for
  const text = video ? drafts[video.id] ?? '' : ''
  const setText = (v: string) => { if (video) setDrafts((d) => ({ ...d, [video.id]: v })) }

  const go = (groupId: string, version?: number) => {
    const q = new URLSearchParams({ video: groupId })
    if (version) q.set('v', String(version))
    router.replace(`/admin/projects/${projectId}/review?${q}`)
    setPicker(null); setActive(null); setReplyTo(null); setPinned(null)
  }

  useEffect(() => {
    if (!video) return
    let cancelled = false
    setUrls(null)
    ;(async () => {
      const token = async (quality: string) => {
        const r = await apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${projectId}&quality=${quality}&sessionId=studio-review:${projectId}`, { cache: 'no-store' })
        const d = r.ok ? await r.json() : null
        return d?.token ? `/api/content/${d.token}` : null
      }
      const stream = (await token('1080p')) ?? (await token('720p')) ?? ''
      const poster = await token('thumbnail')
      if (!cancelled) setUrls({ stream, poster })
    })()
    return () => { cancelled = true }
  }, [video?.id, projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const threads = useMemo(() => comments
    .filter((c) => c.videoId === video?.id && !c.parentId && !c.deleted)
    .map((c) => ({ ...c, seconds: timecodeToSeconds(c.timecode, fps) }))
    .sort((a, b) => a.seconds - b.seconds), [comments, video?.id, fps])
  // open/done is about client feedback; the studio's own notes only show under "all"
  const open = threads.filter((c) => isClient(c) && !c.resolvedAt)
  const done = threads.filter((c) => isClient(c) && !!c.resolvedAt)
  // default view: open feedback, unless something unread sits in a done thread (never hide new feedback)
  const unreadInDone = done.some((c) => unread.has(c.id) || (c.replies ?? []).some((r) => unread.has(r.id)))
  const effectiveFilter: Filter = filter ?? (open.length && !unreadInDone ? 'open' : 'all')
  const shown = effectiveFilter === 'open' ? open : effectiveFilter === 'done' ? done : threads

  const markers: Marker[] = useMemo(() => {
    const by = new Map<number, typeof threads>()
    for (const c of threads) by.set(Math.floor(c.seconds), [...(by.get(Math.floor(c.seconds)) ?? []), c])
    return [...by.values()].map((list) => ({
      id: list[0].id,
      seconds: list[0].seconds,
      label: list.length > 1 ? String(list.length) : initials(list[0].authorName || (isClient(list[0]) ? t('client') : t('studio'))),
      count: list.length,
      studio: !isClient(list[0]),
    }))
  }, [threads])

  // read state: a comment counts as seen after it was visible for a second
  const pendingSeen = useRef(new Set<string>())
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markSeen = useCallback((ids: string[]) => {
    const fresh = ids.filter((id) => unread.has(id))
    if (!fresh.length) return
    fresh.forEach((id) => pendingSeen.current.add(id))
    setUnread((u) => { const n = new Set(u); fresh.forEach((id) => n.delete(id)); return n })
    if (flush.current) clearTimeout(flush.current)
    flush.current = setTimeout(async () => {
      const ids = [...pendingSeen.current]; pendingSeen.current.clear()
      try { await apiPost('/api/studio/seen', { commentIds: ids }); void reloadOverview() } catch { /* retried on next visit */ }
    }, 400)
  }, [unread, reloadOverview])
  const listRef = useRef<HTMLDivElement>(null)
  const markSeenRef = useRef(markSeen)
  useEffect(() => { markSeenRef.current = markSeen }, [markSeen])
  // stable key of what is rendered, so playback re-renders don't restart the observer
  const shownKey = shown.map((c) => [c.id, ...(c.replies ?? []).map((r) => r.id)].join('+')).join(',')
  useEffect(() => {
    const root = listRef.current
    if (!root) return
    const timers = new Map<Element, ReturnType<typeof setTimeout>>()
    // each comment and each reply is observed on its own: seen = itself visible for a second
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.seen
        clearTimeout(timers.get(e.target))
        if (id && e.isIntersecting && e.intersectionRatio >= 0.6) timers.set(e.target, setTimeout(() => markSeenRef.current([id]), 1000))
      }
    }, { root: window.matchMedia('(min-width: 1024px)').matches ? root : null, threshold: [0, 0.6, 1] })
    root.querySelectorAll('[data-seen]').forEach((el) => io.observe(el))
    return () => { io.disconnect(); timers.forEach(clearTimeout) }
  }, [shownKey])

  const seek = (c: { id: string; seconds: number }) => {
    player.current?.seek(c.seconds); player.current?.pause(); setActive(c.id)
    if (!window.matchMedia('(min-width: 1024px)').matches) document.getElementById('fb-player')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const onMarker = (id: string) => {
    setActive(id)
    if (!shown.some((c) => c.id === id)) setFilter('all')
    setTimeout(() => document.getElementById(`c-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50)
  }

  // one resolve request per thread at a time; the UI follows what the server confirmed
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const setResolvedOnServer = async (id: string, resolved: boolean) => {
    setResolving((s) => new Set(s).add(id))
    try {
      const r = await apiPost<{ resolvedAt: string | null }>(`/api/studio/comments/${id}/resolve`, { resolved })
      setComments((list) => list.map((x) => (x.id === id ? { ...x, resolvedAt: r.resolvedAt } : x)))
      return true
    } catch { toast(ts('actionFailed')); return false } finally {
      setResolving((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }
  const resolve = async (c: C, resolved: boolean) => {
    if (resolving.has(c.id)) return
    if (!(await setResolvedOnServer(c.id, resolved))) return
    markSeen([c.id])
    toast(resolved ? t('markedDone') : t('reopened'), async () => { await setResolvedOnServer(c.id, !resolved) })
  }

  const post = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      await apiPost('/api/comments', { projectId, videoId: video!.id, videoVersion: video!.version, isInternal: true, ...body })
      await loadComments()
      return true
    } catch { toast(ts('actionFailed')); return false } finally { setBusy(false) }
  }
  const sendReply = async (c: C) => {
    if (!replyText.trim()) return
    if (await post({ parentId: c.id, timecode: c.timecode, content: replyText.trim() })) {
      setReplyTo(null); setReplyText(''); markSeen([c.id]); toast(t('replySent'))
    }
  }
  const sendComment = async () => {
    if (!text.trim()) return
    const at = pinned ?? player.current?.currentTime() ?? 0
    const forVideo = video!.id
    if (await post({ timecode: secondsToTimecode(at, fps), content: text.trim() })) {
      setDrafts((d) => ({ ...d, [forVideo]: '' })); setPinned(null); setFilter('all')
    }
  }

  if (!project) return <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
  if (!group) return <div className="p-8 text-muted-foreground">{t('noVideos')} <Link className="text-primary underline" href={`/admin/projects/${projectId}`}>{t('back')}</Link></div>

  const banner = isOld
    ? { tone: 'bg-primary/10', icon: <Clock className="h-4 w-4 text-primary" />, title: t('oldVersion', { version: `v${video!.version}` }), sub: <>{t('clientSees', { version: `v${group.current!.version}` })} <button type="button" className="text-primary underline" onClick={() => go(group.groupId)}>{t('toCurrent')}</button></> }
    : group.state === 'changes' ? { tone: 'bg-warning/15', icon: <AlertTriangle className="h-4 w-4 text-warning" />, title: t('changesRequested'), sub: t('changesSub') }
      : group.state === 'waiting' ? { tone: 'bg-primary/10', icon: <Clock className="h-4 w-4 text-primary" />, title: t('waiting'), sub: t('waitingSub') }
        : group.state === 'approved' ? { tone: 'bg-success/15', icon: <Check className="h-4 w-4 text-success" />, title: t('approved'), sub: null }
          : { tone: 'bg-muted', icon: <Clock className="h-4 w-4 text-muted-foreground" />, title: t('inProgress'), sub: t('inProgressSub') }

  // a render function, not a component: a nested component type would remount on every keystroke
  const renderThread = (c: (typeof threads)[number]) => {
    const name = c.authorName || (isClient(c) ? t('client') : t('studio'))
    const isUnread = unread.has(c.id) || (c.replies ?? []).some((r) => unread.has(r.id))
    return (
      <div key={c.id} id={`c-${c.id}`}
        className={`mb-2 rounded-xl border p-3 transition-colors ${active === c.id ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:bg-background/60'}`}>
        <div data-seen={c.id} className="flex items-center gap-2 text-[13px]">
          <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-full text-[10.5px] font-bold text-white" style={{ background: isClient(c) ? colorFor(name) : '#334155' }}>{initials(name)}</span>
          <b className="font-semibold">{name}</b>
          {!isClient(c) && <span className="rounded bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">{t('studio')}</span>}
          <time className="text-xs text-muted-foreground" dateTime={c.createdAt}>{format.relativeTime(new Date(c.createdAt), now)}</time>
          {isUnread && <span className="ml-auto h-[7px] w-[7px] flex-none rounded-full bg-primary" aria-label={t('unread')} />}
        </div>
        <button type="button" onClick={() => seek(c)} className="ml-[34px] mt-1.5 inline-flex h-[22px] items-center gap-1 rounded-md bg-primary/10 px-1.5 text-xs font-semibold tabular-nums text-primary">
          <Clock className="h-3 w-3" />{formatSeconds(c.seconds)}
        </button>
        <div className={`ml-[34px] mt-1.5 whitespace-pre-wrap break-words text-[13.5px] [&_a]:text-primary [&_a]:underline ${c.resolvedAt ? 'text-muted-foreground' : ''}`} dangerouslySetInnerHTML={{ __html: safeHtml(c.content) }} />
        {c.resolvedAt && <div className="ml-[34px] mt-1.5 flex items-center gap-1 text-xs text-success"><Check className="h-3 w-3" />{t('doneNote')}</div>}
        {(c.replies ?? []).filter((r) => !r.deleted).map((r) => {
          const rn = r.authorName || (isClient(r) ? t('client') : t('studio'))
          return (
            <div key={r.id} data-seen={r.id} className="ml-[34px] mt-2.5 border-l-2 border-border pl-3">
              <div className="flex items-center gap-2 text-[13px]">
                <b className="font-semibold">{rn}</b>
                {!isClient(r) && <span className="rounded bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">{t('studio')}</span>}
                <time className="text-xs text-muted-foreground" dateTime={r.createdAt}>{format.relativeTime(new Date(r.createdAt), now)}</time>
                {unread.has(r.id) && <span className="ml-auto h-[7px] w-[7px] rounded-full bg-primary" aria-label={t('unread')} />}
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[13.5px]" dangerouslySetInnerHTML={{ __html: safeHtml(r.content) }} />
            </div>
          )
        })}
        {replyTo === c.id && (
          <form className="ml-[34px] mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void sendReply(c) }}>
            <input autoFocus value={replyText} readOnly={busy} onChange={(e) => setReplyText(e.target.value)} aria-label={t('replyTo', { name })} placeholder={t('replyTo', { name })}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
            <Button type="submit" size="sm" disabled={busy || !replyText.trim()} aria-label={t('sendReply')}><Send className="h-4 w-4" /></Button>
          </form>
        )}
        <div className="ml-7 mt-1.5 flex gap-1">
          <button type="button" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyText('') }} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"><CornerUpLeft className="h-3.5 w-3.5" />{t('reply')}</button>
          {!isClient(c) ? null : c.resolvedAt
            ? <button type="button" disabled={resolving.has(c.id)} onClick={() => resolve(c, false)} className="disabled:opacity-50 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"><RotateCcw className="h-3.5 w-3.5" />{t('reopen')}</button>
            : <button type="button" disabled={resolving.has(c.id)} onClick={() => resolve(c, true)} className="disabled:opacity-50 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-success hover:bg-accent"><Check className="h-3.5 w-3.5" />{t('markDone')}</button>}
        </div>
      </div>
    )
  }

  const emptyText = effectiveFilter === 'open'
    ? (threads.length ? (group.state === 'changes' && !isOld ? t('allDoneChanges') : group.state === 'approved' && !isOld ? t('allDoneApproved') : t('allDone')) : t('noFeedback'))
    : t('nothingHere')

  return (
    <div className="grid min-h-0 flex-1 lg:h-[100dvh] lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col lg:overflow-y-auto">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
          <Link href={`/admin/projects/${projectId}`} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronLeft className="h-4 w-4" />{project.title}</Link>
          <div className="relative">
            <button type="button" aria-expanded={picker === 'video'} onClick={() => setPicker(picker === 'video' ? null : 'video')} className="inline-flex h-9 max-w-[min(340px,calc(100vw-140px))] items-center gap-2 rounded-md border border-border bg-card px-2.5 font-semibold">
              <span className="tabular-nums text-muted-foreground">{groups.indexOf(group) + 1}.</span><span className="truncate">{group.name}</span><ChevronDown className="h-4 w-4 flex-none" />
            </button>
            {picker === 'video' && (
              <div className="absolute left-0 top-full z-50 mt-1.5 w-[min(360px,calc(100vw-24px))] rounded-xl border border-border bg-card p-1.5 shadow-elevation-lg">
                {groups.map((g, i) => (
                  <button key={g.groupId} type="button" onClick={() => go(g.groupId)} aria-current={g === group ? 'true' : undefined}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-accent aria-[current]:bg-accent">
                    <span className="w-5 text-sm font-semibold tabular-nums text-muted-foreground">{i + 1}.</span>
                    <span className="line-clamp-2 flex-1 text-sm font-semibold">{g.name}</span>
                    <span className="text-xs text-muted-foreground">{tp(`state.${g.state}`)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {readyVersions.length > 0 && (
            <div className="relative">
              <button type="button" aria-expanded={picker === 'version'} onClick={() => setPicker(picker === 'version' ? null : 'version')} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-sm">
                v{video?.version}<span className={`text-xs font-semibold ${isOld ? 'text-muted-foreground' : 'text-success'}`}>· {isOld ? t('older') : t('current')}</span><ChevronDown className="h-4 w-4" />
              </button>
              {picker === 'version' && (
                <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[220px] rounded-xl border border-border bg-card p-1.5 shadow-elevation-lg">
                  {readyVersions.map((v) => (
                    <button key={v.id} type="button" onClick={() => go(group.groupId, v.version)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent">
                      <b className="tabular-nums">v{v.version}</b>
                      <span className="text-xs text-muted-foreground">{v === group.current ? t('current') : ''}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">{comments.filter((c) => c.videoId === v.id && !c.parentId && !c.deleted).length} {t('commentsShort')}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
            <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => setNewVersion(group)}><Upload className="mr-1.5 h-4 w-4" />{tp('newVersion')}</Button>
            {!isOld && group.current && (group.state === 'draft' || group.state === 'changes') && (
              <Button className="flex-1 sm:flex-none" onClick={() => setSending(group)}><Send className="mr-1.5 h-4 w-4" />{tp('sendForApproval')}</Button>
            )}
          </div>
        </div>

        <div className="p-3 sm:p-5" id="fb-player">
          {urls && video ? (
            <Player ref={player} src={urls.stream} poster={urls.poster} duration={video.duration ?? 0} markers={markers} showPreviewBadge={false}
              vertical={!!video.height && !!video.width && video.height > video.width} onTime={setTime} onMarker={onMarker} activeMarkerId={active} />
          ) : (
            <div className="grid aspect-video place-items-center rounded-xl bg-black/90 text-white/70"><Loader2 className="h-6 w-6 animate-spin" /></div>
          )}
          {video?.versionNote && <p className="mt-3 text-sm"><b>{t('newIn', { version: `v${video.version}` })}</b> {video.versionNote}</p>}
        </div>
      </div>

      <aside aria-label={t('feedback')} className="flex min-h-0 flex-col border-t border-border bg-card lg:h-[100dvh] lg:border-l lg:border-t-0">
        <div className="px-4 pt-3.5">
          <div className={`mb-3 flex gap-2.5 rounded-xl p-3 text-[13px] ${banner.tone}`}>
            <span className="mt-0.5">{banner.icon}</span>
            <div><b>{banner.title}</b>{banner.sub && <div className="text-muted-foreground">{banner.sub}</div>}</div>
          </div>
          <div role="group" aria-label={t('filter')} className="-mx-4 flex gap-1 border-b border-border px-3">
            {(['open', 'done', 'all'] as Filter[]).map((f) => (
              <button key={f} type="button" aria-pressed={effectiveFilter === f} onClick={() => setFilter(f)}
                className="-mb-px border-b-2 border-transparent px-2 py-2.5 text-sm font-medium text-muted-foreground aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground">
                {t(`filter_${f}`)} <span className="text-xs tabular-nums text-muted-foreground">{f === 'open' ? open.length : f === 'done' ? done.length : threads.length}</span>
              </button>
            ))}
          </div>
        </div>
        <div ref={listRef} className="flex-1 px-4 py-3 lg:overflow-y-auto">
          {shown.length ? shown.map(renderThread) : <p className="px-2 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>}
        </div>
        <form className="sticky bottom-0 border-t border-border bg-card px-4 pb-4 pt-3" onSubmit={(e) => { e.preventDefault(); void sendComment() }}>
          <label htmlFor="fb-studio-comment" className="mb-1 block text-xs text-muted-foreground">{t('composerLabel')}</label>
          <Textarea id="fb-studio-comment" rows={2} value={text} readOnly={busy} onChange={(e) => setText(e.target.value)} placeholder={t('composerPlaceholder')}
            onFocus={() => { player.current?.pause(); if (pinned === null) setPinned(player.current?.currentTime() ?? 0) }} />
          <div className="mt-2 flex items-center justify-between">
            <span className="inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-semibold tabular-nums text-primary"><Clock className="h-3 w-3" />{t('at', { time: formatSeconds(pinned ?? time) })}</span>
            <Button type="submit" size="sm" disabled={busy || !text.trim()}><Send className="mr-1.5 h-4 w-4" />{t('send')}</Button>
          </div>
        </form>
      </aside>

      <SendForReviewDialog group={sending} smtpConfigured={!!project.smtpConfigured} onOpenChange={(o) => { if (!o) setSending(null) }} onDone={() => { void loadProject(); void reloadOverview() }} />
      <NewVersionDialog projectId={projectId} group={newVersion} onOpenChange={(o) => { if (!o) setNewVersion(null) }} onUploaded={() => void loadProject()} />
    </div>
  )
}
