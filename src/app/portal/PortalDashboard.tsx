'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ArrowRight, FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface PortalProject {
  id: string
  slug: string
  title: string
  status: 'IN_REVIEW' | 'APPROVED'
  dueDate: string | null
  lastActivityAt: string
  videos: number
  approved: number
  waiting: number
  changes: number
}

interface Props {
  token: string
  onUnauthorized: () => void
}

/** Client portal (Frameback): what waits for you first, then everything else. */
export default function PortalDashboard({ token, onUnauthorized }: Props) {
  const t = useTranslations('portal')
  const tc = useTranslations('common')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [projects, setProjects] = useState<PortalProject[] | null>(null)
  const [error, setError] = useState('')

  const fetchProjects = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/portal/projects', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (res.status === 401) { onUnauthorized(); return }
      if (!res.ok) { setError(t('failedToLoad')); return }
      const data = await res.json()
      setProjects(data.projects || [])
    } catch {
      setError(t('failedToLoad'))
    }
  }, [token, onUnauthorized, t])

  useEffect(() => { void fetchProjects() }, [fetchProjects])

  const waiting = projects?.filter((p) => p.waiting > 0) ?? []
  const others = projects?.filter((p) => p.waiting === 0) ?? []

  const row = (p: PortalProject) => {
    const allApproved = p.videos > 0 && p.approved === p.videos
    const label = p.waiting > 0 ? t('pleaseReview', { n: p.waiting }) : allApproved ? t('statusApproved') : t('inProgress')
    const tone = p.waiting > 0 ? 'bg-primary/10 text-primary' : allApproved ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
    const seg = (n: number, cls: string) => (n ? <i className={`block ${cls}`} style={{ width: `${(n / p.videos) * 100}%` }} /> : null)
    return (
      <li key={p.id}>
        <a href={`/share/${encodeURIComponent(p.slug)}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3.5 first:border-t-0 hover:bg-background/50 sm:px-5">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold group-hover:text-primary">{p.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{label}</span>
              {p.videos > 0 && <span className="tabular-nums">{t('approvedOf', { done: p.approved, total: p.videos })}</span>}
              {p.dueDate && <span>{t('dueDate', { date: format.dateTime(new Date(p.dueDate), { day: 'numeric', month: 'short', year: 'numeric' }) })}</span>}
              <span>{t('updated', { when: format.relativeTime(new Date(p.lastActivityAt), now) })}</span>
            </div>
            {p.videos > 0 && (
              <div className="mt-2 flex h-[5px] max-w-[220px] overflow-hidden rounded-full bg-muted" aria-hidden>
                {seg(p.approved, 'bg-success')}{seg(p.changes, 'bg-warning')}{seg(p.waiting, 'bg-primary')}
              </div>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
            {p.waiting > 0 ? t('review') : t('open')}<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </a>
      </li>
    )
  }

  return (
    <div className="w-full max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">{t('dashboardTitle')}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{t('dashboardHint')}</p>

      {error && (
        <div className="rounded-xl border border-destructive/40 bg-card p-5">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={fetchProjects}>{tc('errorTryAgain')}</Button>
        </div>
      )}

      {!projects && !error && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}

      {projects && projects.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <FolderOpen className="mx-auto h-9 w-9 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t('empty')}</p>
        </div>
      )}

      {waiting.length > 0 && (
        <section aria-labelledby="portal-waiting" className="mb-7">
          <h2 id="portal-waiting" className="mb-2 text-sm font-semibold">{t('waitingForYou')}</h2>
          <ul className="overflow-hidden rounded-xl border border-primary/30 bg-card shadow-elevation-sm">{waiting.map(row)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="portal-all">
          {waiting.length > 0 && <h2 id="portal-all" className="mb-2 text-sm font-semibold text-muted-foreground">{t('otherProjects')}</h2>}
          <ul className="overflow-hidden rounded-xl border border-border bg-card shadow-elevation-sm">{others.map(row)}</ul>
        </section>
      )}
    </div>
  )
}
