'use client'
/* eslint-disable @next/next/no-img-element -- thumbnails are private, short-lived token URLs that must not pass through the image optimizer */

/**
 * Frameback client share view (FEATURE_NEW_SHARE). Rendered by SharePageClient after
 * authentication, so password / OTP / guest gates stay unchanged.
 * Design: docs/redesign/PLAN.md §4 and prototype v2.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle, Check, ChevronDown, Clock, Download, FileText, Film, HelpCircle, Image as ImageIcon, Layers, Lock, Pencil,
  RotateCcw, Send, Trash2, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import BrandLogo from '@/components/BrandLogo'
import ThemeToggle from '@/components/ThemeToggle'
import LanguageToggle from '@/components/LanguageToggle'
import DOMPurify from 'isomorphic-dompurify'
import { secondsToTimecode, timecodeToSeconds } from '@/lib/timecode'
import Player, { type Marker, type PlayerHandle } from './Player'
import {
  authHeaders, formatSeconds, initials, loadVideoUrls, newIdempotencyKey, posterUrl,
  type ShareComment, type ShareVideo, type VideoUrls,
} from './api'

type Status = 'draft' | 'ready' | 'changes' | 'approved'

interface Props {
  slug: string
  project: any
  shareToken: string | null
  authenticatedName?: string | null
  reviewFlow: boolean
  defaultQuality: '720p' | '1080p' | '2160p'
  onRefresh: () => Promise<void> | void
  onOpenPhotos?: () => void
}

interface Group { name: string; versions: ShareVideo[] } // versions: READY only, newest first

const statusOf = (v: ShareVideo, reviewFlow: boolean): Status => {
  if (v.approved || v.reviewState === 'APPROVED') return 'approved'
  if (!reviewFlow) return 'ready'
  if (v.reviewState === 'IN_REVIEW') return 'ready'
  if (v.reviewState === 'CHANGES_REQUESTED') return 'changes'
  return 'draft'
}
const statusDot: Record<Status, string> = {
  draft: 'text-muted-foreground', ready: 'text-primary', changes: 'text-warning', approved: 'text-success',
}

// Same allowlist as the legacy MessageBubble (content is sanitized server-side too)
const safeHtml = (html: string) => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i,
  ALLOW_DATA_ATTR: false,
  FORCE_BODY: true,
})
/** Stored content is sanitized HTML; the edit box works with plain text. */
const toPlainText = (html: string) =>
  typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(html, 'text/html').body.textContent || '' : html

function download(url: string) {
  // Only same-origin download URLs (token endpoints); never follow foreign URLs
  if (!url.startsWith('/') || url.startsWith('//')) return
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined)

export default function FramebackShareView({
  slug, project, shareToken, authenticatedName, reviewFlow, defaultQuality, onRefresh, onOpenPhotos,
}: Props) {
  const t = useTranslations('fbShare')
  const player = useRef<PlayerHandle>(null)

  // ---- videos -------------------------------------------------------------
  const groups: Group[] = useMemo(() => {
    const byName = (project.videosByName || {}) as Record<string, ShareVideo[]>
    return Object.entries(byName)
      .map(([name, list]) => ({
        name,
        versions: [...list].filter((v) => v.status === 'READY').sort((a, b) => b.version - a.version),
      }))
      .filter((g) => g.versions.length > 0)
  }, [project.videosByName])

  const [groupName, setGroupName] = useState<string | null>(() => {
    const fromUrl = typeof window !== 'undefined' ? new URL(window.location.href).searchParams.get('video') : null
    return fromUrl && groups.some((g) => g.name === fromUrl) ? fromUrl : groups[0]?.name ?? null
  })
  const group = groups.find((g) => g.name === groupName) ?? groups[0]
  const [versionId, setVersionId] = useState<string | null>(null)
  const current = group?.versions[0]
  const selected = group?.versions.find((v) => v.id === versionId) ?? current
  const isOld = !!selected && !!current && selected.id !== current.id
  const status = selected ? statusOf(selected, reviewFlow) : 'draft'

  const [urls, setUrls] = useState<(VideoUrls & { videoId: string }) | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [urlAttempt, setUrlAttempt] = useState(0)
  const [posters, setPosters] = useState<Record<string, string | null>>({})
  const [time, setTime] = useState(0)

  // Stream URL per version. Re-requested when the approval changes (watermark vs clean file).
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setUrls(null)
    setUrlError(null)
    setTime(0)
    loadVideoUrls(slug, shareToken, selected, defaultQuality)
      .then((u) => {
        if (cancelled) return
        if (!u.stream) setUrlError(t('streamUnavailable'))
        else setUrls({ ...u, videoId: selected.id })
      })
      .catch(() => { if (!cancelled) setUrlError(t('streamUnavailable')) })
    return () => { cancelled = true }
  }, [slug, shareToken, selected?.id, selected?.approved, defaultQuality, urlAttempt]) // eslint-disable-line react-hooks/exhaustive-deps
  const urlsReady = !!urls && urls.videoId === selected?.id

  useEffect(() => {
    let cancelled = false
    Promise.all(groups.map(async (g) => [g.versions[0].id, await posterUrl(slug, shareToken, g.versions[0].id)] as const))
      .then((entries) => { if (!cancelled) setPosters(Object.fromEntries(entries)) })
    return () => { cancelled = true }
  }, [groups, slug, shareToken])

  const pickGroup = (name: string) => {
    setGroupName(name)
    setVersionId(null)
    setNavOpen(false)
    setVerMenu(false)
    const url = new URL(window.location.href)
    url.searchParams.set('video', name)
    url.searchParams.delete('version')
    window.history.replaceState(null, '', url)
  }

  // ---- name (no account) ----------------------------------------------------
  const nameKey = `fb:name:${slug}`
  const [name, setName] = useState('')
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem(nameKey) } catch { /* private mode */ }
    const recipient = project.recipients?.find((r: any) => r.id === project.authenticatedRecipientId)
    const initial = stored || authenticatedName || recipient?.name || ''
    setName(initial)
    if (!stored) setWelcome(true)
  }, [nameKey, authenticatedName, project.recipients, project.authenticatedRecipientId])
  const saveName = (value: string) => {
    const v = value.trim()
    setName(v)
    try { localStorage.setItem(nameKey, v) } catch { /* ignore */ }
  }

  // ---- comments ---------------------------------------------------------------
  const [comments, setComments] = useState<ShareComment[]>([])
  const feedback = project.feedbackEnabled !== false && !project.isGuest
  const loadComments = useCallback(async () => {
    if (!feedback) return
    const res = await fetch(`/api/share/${slug}/comments`, { headers: authHeaders(shareToken), cache: 'no-store' })
    if (res.ok) setComments(await res.json())
  }, [feedback, slug, shareToken])
  useEffect(() => { void loadComments() }, [loadComments])

  const fps = selected?.fps || 24
  const versionComments = useMemo(
    () => comments
      .filter((c) => c.videoId === selected?.id)
      .map((c) => ({ ...c, seconds: c.timecode ? timecodeToSeconds(c.timecode, fps) : 0 }))
      .sort((a, b) => a.seconds - b.seconds),
    [comments, selected?.id, fps]
  )
  const markers: Marker[] = useMemo(() => {
    const bySecond = new Map<number, typeof versionComments>()
    for (const c of versionComments) {
      if (c.deleted) continue
      const k = Math.floor(c.seconds)
      bySecond.set(k, [...(bySecond.get(k) ?? []), c])
    }
    return [...bySecond.entries()].map(([s, list]) => ({
      id: list[0].id,
      seconds: s,
      label: list.length > 1 ? `${list.length} ${t('comments')}` : initials(list[0].authorName),
      count: list.length,
      studio: list[0].isInternal,
    }))
  }, [versionComments, t])
  const commentCountFor = (videoId: string) => comments.filter((c) => c.videoId === videoId && !c.deleted).length

  const [tab, setTab] = useState<'comments' | 'files'>('comments')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const draftKey = selected?.id ?? ''
  const [withTime, setWithTime] = useState(true)
  const [posting, setPosting] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 6000); return () => clearTimeout(id) }, [toast])

  const sendingRef = useRef(false)
  const send = async () => {
    const raw = draft[draftKey] || ''
    const content = raw.trim()
    if (!content || !selected || sendingRef.current) return
    sendingRef.current = true
    setPosting(true)
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: authHeaders(shareToken, true),
        body: JSON.stringify({
          projectId: project.id,
          videoId: selected.id,
          videoVersion: selected.version,
          timecode: secondsToTimecode(withTime ? time : 0, fps),
          content,
          isInternal: false,
          authorName: name || undefined,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('failed'))
      setComments(await res.json())
      // Clear only what was sent; text typed during the request stays
      setDraft((d) => ({ ...d, [draftKey]: d[draftKey] === raw ? '' : d[draftKey] }))
      setToast({ text: t('commentSent') })
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : t('failed') })
    } finally {
      sendingRef.current = false
      setPosting(false)
    }
  }

  const mutate = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: authHeaders(shareToken, !!body), body: body ? JSON.stringify(body) : undefined })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('failed'))
  }
  const saveEdit = async () => {
    if (!editing?.text.trim()) return
    try { await mutate(`/api/comments/${editing.id}`, 'PATCH', { content: editing.text }); setEditing(null); await loadComments() }
    catch (e) { setToast({ text: e instanceof Error ? e.message : t('failed') }) }
  }
  const remove = async (id: string) => {
    try {
      await mutate(`/api/comments/${id}`, 'DELETE')
      await loadComments()
      setToast({ text: t('commentDeleted'), undo: async () => { await mutate(`/api/comments/${id}/restore`, 'POST'); await loadComments() } })
    } catch (e) { setToast({ text: e instanceof Error ? e.message : t('failed') }) }
  }
  const jumpTo = (c: { id: string; seconds: number }) => {
    player.current?.seek(c.seconds)
    player.current?.pause()
    setHighlight(c.id)
    setTab('comments')
    setTimeout(() => document.getElementById(`fbc-${c.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30)
  }

  // ---- decisions ------------------------------------------------------------
  const canDecide = !!selected && !isOld && !project.isGuest && project.clientCanApprove !== false && status === 'ready'
  const canRequestChanges = canDecide && reviewFlow
  const [dialog, setDialog] = useState<null | 'approve' | 'changes' | 'help'>(null)
  // The decision target is frozen when the dialog opens; a refresh cannot swap the version.
  const [target, setTarget] = useState<{ videoId: string; version: number; name: string; versionLabel: string; createdAt: string } | null>(null)
  const decidingRef = useRef(false)
  const [changesNote, setChangesNote] = useState('')
  const [deciding, setDeciding] = useState(false)
  const decisionKey = useRef(newIdempotencyKey())
  const openDialog = (d: 'approve' | 'changes') => {
    if (!selected || !canDecide) return
    if (!target || target.videoId !== selected.id) {
      decisionKey.current = newIdempotencyKey()
      setTarget({ videoId: selected.id, version: selected.version, name: selected.name, versionLabel: selected.versionLabel, createdAt: selected.createdAt })
    }
    setDialog(d)
  }
  // Close a decision dialog when its target is no longer decidable (refresh, new version)
  useEffect(() => {
    if ((dialog === 'approve' || dialog === 'changes') && target && (!canDecide || selected?.id !== target.videoId) && !decidingRef.current) {
      setDialog(null)
      setTarget(null)
    }
  }, [dialog, target, canDecide, selected?.id])
  const clientCommentIds = versionComments.filter((c) => !c.isInternal && !c.deleted).map((c) => c.id)

  const approve = async () => {
    if (!target || decidingRef.current) return
    decidingRef.current = true
    setDeciding(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/approve`, {
        method: 'POST',
        headers: { ...authHeaders(shareToken, true), 'Idempotency-Key': decisionKey.current },
        body: JSON.stringify({ selectedVideoId: target.videoId, authorName: name || undefined }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('failed'))
      setDialog(null)
      setToast({ text: t('approvedToast', { name: target.name, version: target.versionLabel }) })
      setTarget(null)
      await onRefresh()
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : t('failed') })
    } finally {
      decidingRef.current = false
      setDeciding(false)
    }
  }
  const requestChanges = async () => {
    if (!target || decidingRef.current) return
    decidingRef.current = true
    setDeciding(true)
    try {
      const res = await fetch(`/api/share/${slug}/decisions`, {
        method: 'POST',
        headers: { ...authHeaders(shareToken, true), 'Idempotency-Key': decisionKey.current },
        body: JSON.stringify({ videoId: target.videoId, kind: 'REQUEST_CHANGES', authorName: name || undefined, note: changesNote || null, commentIds: clientCommentIds }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('failed'))
      setDialog(null)
      setChangesNote('')
      setTarget(null)
      setToast({ text: t('changesToast') })
      await onRefresh()
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : t('failed') })
    } finally {
      decidingRef.current = false
      setDeciding(false)
    }
  }

  // ---- files ----------------------------------------------------------------
  const [assetState, setAssetState] = useState<{ videoId: string; list: Array<{ id: string; fileName: string; fileSize: string; category?: string | null }> } | null>(null)
  const assets = assetState && assetState.videoId === selected?.id ? assetState.list : []
  const [showThumbs, setShowThumbs] = useState(false)
  const [showExtra, setShowExtra] = useState(false)
  useEffect(() => {
    if (!selected?.hasAssets) { setAssetState(null); return }
    let cancelled = false
    const videoId = selected.id
    fetch(`/api/videos/${videoId}/assets`, { headers: authHeaders(shareToken), cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((d) => { if (!cancelled) setAssetState({ videoId, list: d.assets || [] }) })
      .catch(() => { if (!cancelled) setAssetState({ videoId, list: [] }) })
    return () => { cancelled = true }
  }, [selected?.id, selected?.hasAssets, shareToken])
  const isApproved = (v?: ShareVideo) => !!v && (!!v.approved || v.reviewState === 'APPROVED')
  const finalAvailable = isApproved(selected) && project.allowAssetDownload !== false
  const lockReason = project.allowAssetDownload === false
    ? t('downloadsDisabled')
    : isOld ? t('onlyApprovedVersion') : t('availableAfterApproval')
  const tokenDownload = async (url: string, body: unknown = {}) => {
    try {
      const res = await fetch(url, { method: 'POST', headers: authHeaders(shareToken, true), body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.url) throw new Error(data.error || t('failed'))
      download(data.url)
    } catch (e) { setToast({ text: e instanceof Error ? e.message : t('failed') }) }
  }
  const images = assets.filter((a) => a.category === 'image')
  const others = assets.filter((a) => a.category !== 'image')

  // ---- layout state -----------------------------------------------------------
  const [navOpen, setNavOpen] = useState(false)
  const [verMenu, setVerMenu] = useState(false)
  const verBtn = useRef<HTMLButtonElement>(null)
  const [typing, setTyping] = useState(false)
  const typingHandlers = useMemo(() => [() => setTyping(true), () => setTyping(false)] as [() => void, () => void], [])
  const approvedCount = groups.filter((g) => isApproved(g.versions[0])).length
  const showNav = groups.length + (project.hasPhotos ? 1 : 0) > 1
  const showDecisionBar = canDecide

  if (!group || !selected) {
    return <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">{t('noVideos')}</div>
  }

  const navList = (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between px-2 pb-1 text-sm">
        <b>{t('videos')}</b>
        <span className="text-xs text-muted-foreground">{t('approvedOf', { done: approvedCount, total: groups.length })}</span>
      </div>
      {groups.map((g) => {
        const s = statusOf(g.versions[0], reviewFlow)
        const active = g.name === group.name
        return (
          <button
            key={g.name}
            type="button"
            onClick={() => pickGroup(g.name)}
            aria-current={active ? 'true' : undefined}
            className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left transition ${active ? 'border-border bg-muted' : 'border-transparent hover:bg-muted/60'}`}
          >
            <span className="relative aspect-video w-[76px] flex-none overflow-hidden rounded-md bg-muted">
              {posters[g.versions[0].id] && <img src={posters[g.versions[0].id]!} alt="" className="h-full w-full object-cover" />}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <b className="truncate text-sm font-semibold">{g.name}</b>
              <span className={`flex items-center gap-1.5 text-xs ${statusDot[s]}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                {t(`status.${s}`)}
              </span>
            </span>
          </button>
        )
      })}
      {project.hasPhotos && onOpenPhotos && (
        <>
          <div className="px-2 pb-1 pt-3 text-sm"><b>{t('photos')}</b></div>
          <button type="button" onClick={onOpenPhotos} className="flex w-full items-center gap-3 rounded-lg border border-transparent p-2 text-left hover:bg-muted/60">
            <span className="flex aspect-video w-[76px] flex-none items-center justify-center rounded-md bg-muted"><ImageIcon className="h-5 w-5 text-muted-foreground" /></span>
            <b className="text-sm font-semibold">{t('openPhotos')}</b>
          </button>
        </>
      )}
    </div>
  )

  const statusLine = () => {
    if (isOld) return null
    if (status === 'draft') return (
      <div className="flex items-start gap-2.5 rounded-xl bg-muted p-3 text-sm text-muted-foreground">
        <Clock className="mt-0.5 h-4 w-4 flex-none" /><span><b className="text-foreground">{t('draftTitle')}</b> {t('draftText')}</span>
      </div>
    )
    if (status === 'changes') return (
      <div className="flex items-start gap-2.5 rounded-xl bg-warning-visible p-3 text-sm text-warning">
        <RotateCcw className="mt-0.5 h-4 w-4 flex-none" /><span><b>{t('changesTitle')}</b> {t('changesText')}</span>
      </div>
    )
    if (status === 'approved') return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-success-visible p-3 text-sm text-success">
        <Check className="h-4 w-4 flex-none" /><span className="flex-1"><b>{t('approvedTitle')}</b></span>
        <Button size="sm" onClick={() => setTab('files')}><Download className="mr-1.5 h-4 w-4" />{t('download')}</Button>
      </div>
    )
    return null
  }

  return (
    <div className={`flex min-h-screen flex-col bg-background ${showDecisionBar ? 'pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-0' : ''} ${typing ? 'fb-typing' : ''}`}>
      {/* top bar */}
      <header className="flex items-center gap-3 border-b bg-card px-4 py-2.5">
        <BrandLogo height={28} />
        <div className="flex min-w-0 flex-col">
          <b className="truncate text-[15px]">{project.title}</b>
          {(project.companyName || project.clientName) && <span className="truncate text-xs text-muted-foreground">{project.companyName || project.clientName}</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label={t('help')} onClick={() => setDialog('help')}><HelpCircle className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">{t('help')}</span></Button>
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        {showNav && <aside className="hidden w-[280px] flex-none border-r bg-card p-3 lg:block">{navList}</aside>}

        {/* stage */}
        <section className="flex min-w-0 flex-1 flex-col gap-3.5 p-4 md:p-5">
          {showNav && (
            <div className="relative lg:hidden">
              <button type="button" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen} className="flex w-full items-center gap-3 rounded-xl border bg-card p-2 text-left">
                <span className="aspect-video w-14 flex-none overflow-hidden rounded bg-muted">
                  {posters[current!.id] && <img src={posters[current!.id]!} alt="" className="h-full w-full object-cover" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col"><b className="truncate text-sm">{group.name}</b>
                  <span className={`text-xs ${statusDot[statusOf(current!, reviewFlow)]}`}>{t(`status.${statusOf(current!, reviewFlow)}`)}</span></span>
                <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">{t('itemsCount', { n: groups.length + (project.hasPhotos ? 1 : 0) })}<ChevronDown className="h-4 w-4" /></span>
              </button>
              {navOpen && <div className="absolute inset-x-0 top-full z-40 mt-1.5 rounded-xl border bg-card p-1.5 shadow-xl">{navList}</div>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{group.name}</h1>
            {group.versions.length > 1 ? (
              <div className="relative">
                <button ref={verBtn} type="button" onClick={() => setVerMenu((m) => !m)} aria-expanded={verMenu} aria-haspopup="menu" className="inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm font-semibold">
                  {t('version', { n: selected.version })}
                  {!isOld && <span className="text-xs font-semibold text-success">· {t('current')}</span>}
                  <ChevronDown className="h-4 w-4" />
                </button>
                {verMenu && (
                  <div role="menu" onKeyDown={(e) => { if (e.key === 'Escape') { setVerMenu(false); verBtn.current?.focus() } }}
                    className="absolute left-0 top-11 z-30 w-[min(20rem,calc(100vw-2rem))] rounded-xl border bg-card p-1.5 shadow-xl">
                    {group.versions.map((v, i) => (
                      <button key={v.id} role="menuitem" type="button" autoFocus={v.id === selected.id} onClick={() => { setVersionId(i === 0 ? null : v.id); setVerMenu(false); verBtn.current?.focus() }}
                        className={`grid w-full grid-cols-[1fr_auto] gap-x-2 rounded-lg p-2.5 text-left hover:bg-muted ${v.id === selected.id ? 'bg-primary-visible' : ''}`}>
                        <b className="text-sm">{t('version', { n: v.version })}{i === 0 ? ` · ${t('current')}` : ''}</b>
                        <span className="text-xs text-muted-foreground">{fmtDate(v.createdAt)}</span>
                        <small className="col-span-2 text-xs text-muted-foreground">{t('commentsCount', { n: commentCountFor(v.id) })}{v.versionNote ? ` · ${v.versionNote}` : ''}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">{t('version', { n: selected.version })}</span>
            )}
          </div>

          {isOld ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warning-visible px-3.5 py-2.5 text-sm font-medium text-warning">
              <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />{t('oldVersion', { n: current!.version })}</span>
              <Button size="sm" variant="outline" onClick={() => setVersionId(null)}>{t('toCurrent')}</Button>
            </div>
          ) : selected.versionNote ? (
            <p className="m-0 text-sm text-muted-foreground"><b className="font-semibold text-foreground">{t('newIn', { n: selected.version })}</b> {selected.versionNote}</p>
          ) : null}

          {urlError ? (
            <div className="flex aspect-video max-h-[62vh] flex-col items-center justify-center gap-3 rounded-xl bg-muted p-6 text-center text-sm text-muted-foreground">
              {urlError}
              <Button size="sm" variant="outline" onClick={() => setUrlAttempt((n) => n + 1)}>{t('retry')}</Button>
            </div>
          ) : urlsReady ? (
            <Player
              key={selected.id}
              ref={player}
              src={urls!.stream}
              poster={urls!.poster}
              duration={selected.duration}
              markers={markers}
              showPreviewBadge={!selected.approved || isOld}
              vertical={!!selected.height && !!selected.width && selected.height > selected.width}
              onTime={setTime}
              onMarker={(id) => { const c = versionComments.find((x) => x.id === id); if (c) jumpTo(c) }}
            />
          ) : (
            <div className="flex aspect-video max-h-[62vh] items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">{t('loading')}</div>
          )}

          {statusLine()}

          {showDecisionBar && (
            <div className="fb-decision fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center gap-3 rounded-t-2xl border bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl md:static md:rounded-xl md:p-4 md:shadow-none">
              <div className="flex min-w-0 flex-1 basis-full items-start gap-2.5 md:basis-auto">
                <span className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-primary" aria-hidden />
                <div><b className="block">{t('readyTitle', { n: selected.version })}</b>
                  <span className="hidden text-sm text-muted-foreground md:block">{reviewFlow ? t('readyText') : t('readyTextLegacy')}</span></div>
              </div>
              <div className="flex w-full gap-2 md:w-auto">
                {canRequestChanges && <Button variant="outline" className="flex-1 md:flex-none" onClick={() => openDialog('changes')}>{t('requestChanges')}</Button>}
                <Button className="flex-1 bg-success text-success-foreground hover:bg-success/90 md:flex-none" onClick={() => openDialog('approve')}><Check className="mr-1.5 h-4 w-4" />{t('approve')}</Button>
              </div>
            </div>
          )}
        </section>

        {/* side panel */}
        <aside className="flex min-h-0 w-full flex-none flex-col border-t bg-card md:w-[380px] md:border-l md:border-t-0 lg:w-[400px]">
          <div role="tablist" className="flex gap-1 border-b px-3 pt-2">
            {(['comments', 'files'] as const).map((k) => (
              <button key={k} id={`fb-tab-${k}`} role="tab" type="button" aria-selected={tab === k} aria-controls="fb-tabpanel" onClick={() => setTab(k)}
                className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-semibold ${tab === k ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'}`}>
                {t(k)}{k === 'files' && !finalAvailable && <Lock className="ml-1.5 inline h-3 w-3 align-[-1px] text-muted-foreground" aria-hidden />}{k === 'comments' && versionComments.filter((c) => !c.deleted).length > 0 && (
                  <span className="ml-1.5 inline-grid min-w-5 place-items-center rounded-full bg-muted px-1.5 text-[11px]">{versionComments.filter((c) => !c.deleted).length}</span>
                )}
              </button>
            ))}
          </div>

          <div id="fb-tabpanel" role="tabpanel" aria-labelledby={`fb-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
          {tab === 'comments' ? (
            <>
              <div className="flex-1 overflow-auto p-3.5">
                {!feedback && <p className="p-4 text-sm text-muted-foreground">{t('feedbackOff')}</p>}
                {feedback && versionComments.length === 0 && (
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('noComments')}</div>
                )}
                {versionComments.map((c) => (
                  <CommentItem key={c.id} c={c} fps={fps} highlight={highlight === c.id}
                    editing={editing} setEditing={setEditing} onSave={saveEdit} onDelete={remove} onJump={jumpTo} t={t}
                    onTyping={typingHandlers} />
                ))}
              </div>
              {feedback && !isOld && (
                <div className="border-t p-3.5 pb-6">
                  {canRequestChanges && <p className="mb-2 text-xs text-muted-foreground">{t('composerHint')}</p>}
                  <Textarea
                    value={draft[draftKey] || ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [draftKey]: e.target.value }))}
                    onFocus={() => { setTyping(true); player.current?.pause() }}
                    onBlur={() => setTyping(false)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }}
                    placeholder={t('placeholder')}
                    aria-label={t('placeholderLabel', { name: name || t('you') })}
                    maxLength={10000}
                  />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <button type="button" aria-pressed={withTime} onClick={() => setWithTime((w) => !w)}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold ${withTime ? 'border-transparent bg-primary-visible text-primary' : 'bg-muted text-muted-foreground'}`}>
                      <Clock className="h-3.5 w-3.5" />{withTime ? t('atTime', { time: formatSeconds(time) }) : t('noTime')}
                    </button>
                    <Button size="sm" onClick={() => void send()} disabled={posting || !(draft[draftKey] || '').trim()}><Send className="mr-1.5 h-3.5 w-3.5" />{t('send')}</Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 overflow-auto p-3.5">
              {isOld && <p className="mb-2.5 flex items-center gap-2 rounded-lg bg-muted p-2.5 text-xs text-muted-foreground"><Layers className="h-4 w-4" />{t('filesOfOld', { n: selected.version })}</p>}
              <FileRow icon={<Film className="h-4 w-4" />} title={t('finalVideo')} sub={finalAvailable ? selected.originalFileName : lockReason}
                locked={!finalAvailable} onDownload={() => tokenDownload(`/api/videos/${selected.id}/download-token`)} t={t} />
              {urlsReady && urls?.stream && (
                <FileRow icon={<Film className="h-4 w-4" />} title={selected.approved ? t('previewClean') : t('previewWatermark')} sub={t('previewSub')}
                  onDownload={() => download(`${urls.stream}${urls.stream.includes('?') ? '&' : '?'}download=true`)} t={t} />
              )}
              {images.length > 0 && (
                <>
                  <button type="button" onClick={() => setShowThumbs((s) => !s)} aria-expanded={showThumbs} className="flex w-full items-center gap-1.5 px-0.5 pb-2 pt-3 text-left text-sm font-semibold">
                    <ChevronDown className={`h-4 w-4 transition ${showThumbs ? '' : '-rotate-90'}`} />{t('thumbnails')} <span className="text-muted-foreground">({images.length})</span>
                  </button>
                  {showThumbs && images.map((a) => (
                    <FileRow key={a.id} icon={<ImageIcon className="h-4 w-4" />} title={a.fileName} sub={finalAvailable ? '' : lockReason} locked={!finalAvailable}
                      onDownload={() => tokenDownload(`/api/videos/${selected.id}/assets/${a.id}/download-token`)} t={t} />
                  ))}
                </>
              )}
              {others.length > 0 && (
                <>
                  <button type="button" onClick={() => setShowExtra((s) => !s)} aria-expanded={showExtra} className="flex w-full items-center gap-1.5 px-0.5 pb-2 pt-3 text-left text-sm font-semibold">
                    <ChevronDown className={`h-4 w-4 transition ${showExtra ? '' : '-rotate-90'}`} />{t('moreFiles')} <span className="text-muted-foreground">({others.length})</span>
                  </button>
                  {showExtra && others.map((a) => (
                    <FileRow key={a.id} icon={<FileText className="h-4 w-4" />} title={a.fileName} sub={finalAvailable ? '' : lockReason} locked={!finalAvailable}
                      onDownload={() => tokenDownload(`/api/videos/${selected.id}/assets/${a.id}/download-token`)} t={t} />
                  ))}
                </>
              )}
              {finalAvailable && assets.length > 0 && (
                <>
                  <Button variant="outline" className="mt-3 w-full" onClick={() => tokenDownload(`/api/videos/${selected.id}/assets/download-zip-token`, { assetIds: assets.map((a) => a.id).slice(0, 50), includeVideo: true })}>
                    <Download className="mr-1.5 h-4 w-4" />{t('downloadAll')}
                  </Button>
                  {assets.length > 50 && <p className="mt-1.5 text-xs text-muted-foreground">{t('zipLimit')}</p>}
                </>
              )}
            </div>
          )}
          </div>
        </aside>
      </div>

      {/* dialogs */}
      <Dialog open={welcome} onOpenChange={(o) => { if (!o) { saveName(name); setWelcome(false) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('welcomeTitle')}</DialogTitle>
            <DialogDescription>{t('welcomeIntro', { project: project.title })}</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li><b className="text-foreground">{t('step1')}</b> {t('step1Text')}</li>
            <li><b className="text-foreground">{t('step2')}</b> {t('step2Text')}</li>
            <li><b className="text-foreground">{t('step3')}</b> {t('step3Text')}</li>
          </ol>
          <label htmlFor="fb-name" className="text-sm font-semibold">{t('yourName')}</label>
          <Input id="fb-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <p className="text-xs text-muted-foreground">{t('noAccount')}</p>
          <DialogFooter><Button onClick={() => { saveName(name); setWelcome(false) }}>{t('start')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'approve'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('approveTitle', { n: target?.version ?? selected.version })}</DialogTitle>
            <DialogDescription>{t('approveIntro')}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 rounded-xl bg-muted p-3">
            <span className="aspect-video w-24 flex-none overflow-hidden rounded bg-background">{urlsReady && urls?.poster && <img src={urls.poster} alt="" className="h-full w-full object-cover" />}</span>
            <div><b>{target?.name ?? selected.name}</b><div className="text-sm text-muted-foreground">{t('version', { n: target?.version ?? selected.version })} · {fmtDate(target?.createdAt ?? selected.createdAt)}</div></div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('approveBullet1')}</li><li>{t('approveBullet2')}</li><li>{t('approveBullet3')}</li>
          </ul>
          {clientCommentIds.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-warning-visible p-2.5 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />{t('approveWarnComments', { n: clientCommentIds.length })}
            </p>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>{t('cancel')}</Button>
            {canRequestChanges && <Button variant="outline" onClick={() => openDialog('changes')}>{t('ratherRequestChanges')}</Button>}
            <Button className="bg-success text-success-foreground hover:bg-success/90" onClick={approve} disabled={deciding}><Check className="mr-1.5 h-4 w-4" />{t('approveConfirm', { n: target?.version ?? selected.version })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'changes'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('changesDialogTitle')}</DialogTitle>
            <DialogDescription>{t('changesDialogIntro', { n: clientCommentIds.length, name: target?.name ?? selected.name, version: target?.version ?? selected.version })}</DialogDescription>
          </DialogHeader>
          <label htmlFor="fb-changes" className="text-sm font-semibold">{t('summaryLabel')}</label>
          <Textarea id="fb-changes" value={changesNote} onChange={(e) => setChangesNote(e.target.value)} maxLength={2000} placeholder={t('summaryPlaceholder')} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>{t('cancel')}</Button>
            <Button onClick={requestChanges} disabled={deciding}><Send className="mr-1.5 h-4 w-4" />{t('sendToStudio')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'help'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('helpTitle')}</DialogTitle></DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {[1, 2, 3, 4, 5].map((i) => <li key={i}><b className="text-foreground">{t(`help${i}Title`)}</b> – {t(`help${i}Text`)}</li>)}
          </ol>
          <DialogFooter><Button onClick={() => setDialog(null)}>{t('understood')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {toast && (
        <div role="status" className="fixed bottom-28 left-1/2 z-[60] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-2xl md:bottom-6">
          {toast.text}
          {toast.undo && <button type="button" className="font-bold underline" onClick={async () => {
            const u = toast.undo!
            try { await u(); setToast(null) } catch (e) { setToast({ text: e instanceof Error ? e.message : t('failed') }) }
          }}>{t('undo')}</button>}
          <button type="button" aria-label={t('close')} onClick={() => setToast(null)}><X className="h-4 w-4" /></button>
        </div>
      )}
    </div>
  )
}

function FileRow({ icon, title, sub, locked, onDownload, t }: {
  icon: React.ReactNode; title?: string | null; sub?: string | null; locked?: boolean; onDownload: () => void; t: (k: string) => string
}) {
  return (
    <div className={`mb-2 flex items-center gap-3 rounded-xl border p-2.5 ${locked ? 'opacity-75' : ''}`}>
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-muted text-muted-foreground">{locked ? <Lock className="h-4 w-4" /> : icon}</span>
      <span className="min-w-0 flex-1"><b className="block truncate text-sm">{title}</b>{sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}</span>
      {!locked && (
        <Button size="sm" variant="outline" onClick={onDownload} aria-label={`${title} – ${t('download')}`}>
          <Download className="h-3.5 w-3.5 sm:mr-1.5" /><span className="hidden sm:inline">{t('download')}</span>
        </Button>
      )}
    </div>
  )
}

function CommentItem({ c, fps, highlight, editing, setEditing, onSave, onDelete, onJump, t, onTyping }: {
  c: ShareComment & { seconds: number }; fps: number; highlight: boolean
  editing: { id: string; text: string } | null; setEditing: (e: { id: string; text: string } | null) => void
  onSave: () => void; onDelete: (id: string) => void; onJump: (c: { id: string; seconds: number }) => void
  t: (k: string, v?: Record<string, string | number>) => string
  onTyping?: [() => void, () => void]
}) {
  const replies = (c.replies || []).map((r) => ({ ...r, seconds: r.timecode ? timecodeToSeconds(r.timecode, fps) : c.seconds }))
  return (
    <div id={`fbc-${c.id}`} className={`rounded-xl p-3 ${highlight ? 'bg-primary-visible' : ''}`}>
      {c.deleted ? (
        <p className="text-sm italic text-muted-foreground">{t('deletedPlaceholder')}</p>
      ) : (
        <Bubble c={c} editing={editing} setEditing={setEditing} onSave={onSave} onDelete={onDelete} onJump={onJump} t={t} onTyping={onTyping} />
      )}
      {replies.filter((r) => !r.deleted).map((r) => (
        <div key={r.id} className="ml-7 mt-2">
          <Bubble c={r} editing={editing} setEditing={setEditing} onSave={onSave} onDelete={onDelete} onJump={onJump} t={t} onTyping={onTyping} hideTime />
        </div>
      ))}
    </div>
  )
}

function Bubble({ c, editing, setEditing, onSave, onDelete, onJump, t, hideTime, onTyping }: {
  c: ShareComment & { seconds: number }
  editing: { id: string; text: string } | null; setEditing: (e: { id: string; text: string } | null) => void
  onSave: () => void; onDelete: (id: string) => void; onJump: (c: { id: string; seconds: number }) => void
  t: (k: string, v?: Record<string, string | number>) => string; hideTime?: boolean
  onTyping?: [() => void, () => void]
}) {
  const isEditing = editing?.id === c.id
  return (
    <div className="flex gap-2.5">
      <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs font-bold text-white ${c.isInternal ? 'bg-primary' : c.canEdit ? 'bg-emerald-600' : 'bg-violet-600'}`}>{initials(c.authorName)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <b>{c.authorName || (c.isInternal ? t('studio') : t('client'))}{c.canEdit && !c.isInternal ? ` (${t('you')})` : ''}</b>
          {c.isInternal && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{t('studio')}</span>}
          <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}{c.editedAt ? ` · ${t('edited')}` : ''}</span>
        </div>
        {!hideTime && c.seconds > 0 && (
          <button type="button" onClick={() => onJump(c)} className="mt-1 inline-flex items-center gap-1 rounded-md bg-primary-visible px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">
            <Clock className="h-3 w-3" />{formatSeconds(c.seconds)}
          </button>
        )}
        {isEditing ? (
          <>
            <Textarea className="mt-1.5" onFocus={onTyping?.[0]} onBlur={onTyping?.[1]} value={editing!.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} aria-label={t('editComment')} autoFocus />
            <div className="mt-1.5 flex gap-2"><Button size="sm" onClick={onSave}>{t('save')}</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('cancel')}</Button></div>
          </>
        ) : (
          <div className="mt-1 whitespace-pre-wrap break-words text-sm [&_a]:text-primary [&_a]:underline" dangerouslySetInnerHTML={{ __html: safeHtml(c.content) }} />
        )}
        {c.canEdit && !isEditing && (
          <div className="mt-1 flex gap-1">
            <button type="button" onClick={() => setEditing({ id: c.id, text: toPlainText(c.content) })} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-3 w-3" />{t('edit')}</button>
            <button type="button" onClick={() => onDelete(c.id)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"><Trash2 className="h-3 w-3" />{t('delete')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
