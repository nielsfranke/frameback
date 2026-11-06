'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, Mail, MoreHorizontal, Pencil, Plus, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiDelete, apiFetch, apiPatch, apiPost } from '@/lib/api-client'
import { useToast } from '../Toast'
import { useStudioData } from '../StudioData'
import { Menu } from '../Menu'
import { MoveDialog } from '../FolderDialogs'
import { Row } from '../StudioOverview'
import { clientColor, clientInitials } from './StudioClients'

interface Detail {
  id: string
  name: string
  contacts: Array<{ id: string; name: string; email: string | null; projects: string[] }>
  recipientSuggestions: Array<{ name: string | null; email: string; projects: string[] }>
}

export default function StudioClient({ id }: { id: string }) {
  const t = useTranslations('studio.clients')
  const ts = useTranslations('studio')
  const router = useRouter()
  const toast = useToast()
  const { projects, reload: reloadOverview } = useStudioData()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [moving, setMoving] = useState<string[] | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/studio/clients/${id}`, { cache: 'no-store' })
      if (r.status === 404) { setMissing(true); return }
      if (!r.ok) throw new Error(String(r.status))
      setDetail(await r.json()); setFailed(false)
    } catch { setFailed(true) }
  }, [id])
  useEffect(() => { void load(); void reloadOverview() }, [load, reloadOverview])

  const mine = useMemo(() => projects.filter((p) => p.client?.id === id), [projects, id])
  const years = useMemo(() => {
    const by = new Map<number, typeof mine>()
    for (const p of mine) { const y = new Date(p.createdAt).getFullYear(); by.set(y, [...(by.get(y) ?? []), p]) }
    return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([y, list]) => [y, list.sort((a, b) => +new Date(b.last?.at ?? b.createdAt) - +new Date(a.last?.at ?? a.createdAt))] as const)
  }, [mine])

  if (missing) return <div className="p-8 text-sm text-muted-foreground">{t('notFound')} <Link href="/admin/clients" className="text-primary underline">{t('title')}</Link></div>
  if (failed && !detail) return <div className="p-8 text-sm">{t('loadFailed')} <Button size="sm" variant="outline" className="ml-2" onClick={() => void load()}>{ts('retry')}</Button></div>
  if (!detail) return <div className="flex flex-1 items-center justify-center p-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>

  const active = mine.filter((p) => !p.archived)
  const complete = mine.filter((p) => p.videos > 0 && p.approved === p.videos).length
  const unread = active.filter((p) => p.unread > 0).length

  const addContact = async (s: Detail['recipientSuggestions'][number]) => {
    try {
      await apiPost(`/api/clients/${id}/contacts`, { name: s.name || s.email, email: s.email })
      toast(t('contactAdded', { name: s.name || s.email }))
      await load()
    } catch { toast(ts('actionFailed')) }
  }
  const rename = async () => {
    try { await apiPatch(`/api/clients/${id}`, { name: name.trim() }); setRenaming(false); await load(); void reloadOverview() } catch { toast(ts('actionFailed')) }
  }
  const remove = async () => {
    if (!window.confirm(t('deleteConfirm', { name: detail.name, n: mine.length }))) return
    try { await apiDelete(`/api/clients/${id}`); void reloadOverview(); router.push('/admin/clients') } catch { toast(ts('actionFailed')) }
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-24 pt-5 sm:px-7">
      <nav className="text-[13px] text-muted-foreground"><Link href="/admin/clients" className="hover:text-foreground">{t('title')}</Link> <span aria-hidden>/</span> {detail.name}</nav>
      <header className="mb-6 mt-3 flex flex-wrap items-center gap-4">
        <span className="grid h-12 w-12 flex-none place-items-center rounded-xl text-base font-bold text-white" style={{ background: clientColor(detail.id) }}>{clientInitials(detail.name)}</span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{detail.name}</h1>
          <div className="mt-1 flex flex-wrap gap-x-4 text-[13px] text-muted-foreground">
            <span><b className="text-foreground">{active.length}</b> {t('activeProjects')}</span>
            <span><b className="text-foreground">{complete}</b> {t('completelyApproved')}</span>
            {unread > 0 && <span><b className="text-foreground">{unread}</b> {t('withNewFeedback')}</span>}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button asChild><Link href={`/admin/projects/new?client=${id}`}><Plus className="mr-1.5 h-4 w-4" />{ts('newProject')}</Link></Button>
          <Menu label={t('clientActions')} trigger={<MoreHorizontal className="h-4 w-4" />} items={[
            { label: t('rename'), icon: <Pencil className="h-4 w-4" />, onSelect: () => { setName(detail.name); setRenaming(true) } },
            { label: t('delete'), icon: <Trash2 className="h-4 w-4" />, danger: true, separatorBefore: true, onSelect: remove },
          ]} />
        </div>
      </header>

      <h2 className="mb-2 text-[15px] font-semibold">{t('projects')}</h2>
      {mine.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">{t('noProjects')}</div>
      ) : years.map(([y, list]) => (
        <div key={y} className="mb-4">
          {years.length > 1 && <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{y}</div>}
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-elevation-sm">
            {list.map((p) => <Row key={p.id} p={p} view={{ kind: 'all' }} onMove={setMoving} showClient={false} />)}
          </div>
        </div>
      ))}

      <div className="mb-2 mt-7 flex items-baseline gap-3">
        <h2 className="text-[15px] font-semibold">{t('contacts')}</h2>
        <span className="text-xs text-muted-foreground">{t('contactsHint')}</span>
      </div>
      {detail.contacts.length === 0 && detail.recipientSuggestions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t('noContacts')}</div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {detail.contacts.map((c) => (
            <div key={c.id} className="rounded-xl border border-border bg-card p-3.5 text-[13px]">
              <b className="block text-sm">{c.name}</b>
              {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-primary hover:underline"><Mail className="h-3 w-3" />{c.email}</a>}
              {c.projects.length > 0 && <div className="mt-1.5 text-xs text-muted-foreground">{t('recipientIn', { projects: c.projects.join(', ') })}</div>}
            </div>
          ))}
          {detail.recipientSuggestions.map((s) => (
            <div key={s.email} className="rounded-xl border border-dashed border-border p-3.5 text-[13px]">
              <b className="block text-sm">{s.name || s.email}</b>
              <span className="text-muted-foreground">{s.email}</span>
              <div className="mt-1.5 text-xs text-muted-foreground">{t('recipientIn', { projects: s.projects.join(', ') })}</div>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => addContact(s)}><UserPlus className="mr-1.5 h-3.5 w-3.5" />{t('addAsContact')}</Button>
            </div>
          ))}
        </div>
      )}

      <MoveDialog projectIds={moving} titleText={moving?.length === 1 ? ts('moveOneTitle', { title: mine.find((p) => p.id === moving[0])?.title ?? '' }) : ts('moveManyTitle', { n: moving?.length ?? 0 })} onOpenChange={(o) => { if (!o) setMoving(null) }} />
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('rename')}</DialogTitle><DialogDescription>{t('renameHint')}</DialogDescription></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void rename() }}>
            <Input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-label={t('clientName')} />
            <DialogFooter className="mt-4"><Button type="button" variant="outline" onClick={() => setRenaming(false)}>{ts('cancel')}</Button><Button type="submit" disabled={!name.trim()}>{ts('save')}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
