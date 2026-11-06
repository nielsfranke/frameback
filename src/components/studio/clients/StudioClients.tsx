'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { Building2, GitMerge, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiDelete, apiFetch, apiPatch, apiPost } from '@/lib/api-client'
import { Menu } from '../Menu'
import { useToast } from '../Toast'
import { useStudioData } from '../StudioData'
import type { BackfillPlan } from '@/lib/clients'

interface ClientRow { id: string; name: string; activeProjects: number; unreadProjects: number; contacts: number; lastActivityAt: string | null }
interface Dup { a: { id: string; name: string; projects: number }; b: { id: string; name: string; projects: number } }

const palette = ['#2563eb', '#0d9488', '#9333ea', '#ea580c', '#16a34a', '#db2777', '#0891b2']
export const clientColor = (id: string) => palette[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length]
export const clientInitials = (name: string) => name.replace(/\b(ag|gmbh|sa|ltd|inc)\b\.?/gi, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'

export default function StudioClients() {
  const t = useTranslations('studio.clients')
  const ts = useTranslations('studio')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const router = useRouter()
  const toast = useToast()
  const { reload: reloadOverview } = useStudioData()
  const [data, setData] = useState<{ clients: ClientRow[]; duplicates: Dup[]; backfill: { projects: number; ambiguous: number } } | null>(null)
  const [error, setError] = useState(false)
  const [q, setQ] = useState('')
  const [plan, setPlan] = useState<BackfillPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/studio/clients', { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      setData(await r.json()); setError(false)
    } catch { setError(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  const rows = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    return (data?.clients ?? []).filter((c) => !needle || c.name.toLocaleLowerCase().includes(needle))
  }, [data, q])

  const openPreview = async () => {
    setBusy(true)
    try { const r = await apiFetch('/api/studio/clients/backfill', { cache: 'no-store' }); if (r.ok) setPlan(await r.json()) } finally { setBusy(false) }
  }
  const applyPreview = async () => {
    if (!plan) return
    setBusy(true)
    try {
      // exactly what the preview showed, in chunks the server accepts
      const items = plan.items.map(({ projectId, companyName, clientId, clientName }) => ({ projectId, companyName, clientId, clientName }))
      let linked = 0, created = 0, skipped = 0
      for (let i = 0; i < items.length; i += 500) {
        const r = await apiPost<{ linked: number; clientsCreated: number; skipped: number }>('/api/studio/clients/backfill', { items: items.slice(i, i + 500) })
        linked += r.linked; created += r.clientsCreated; skipped += r.skipped
      }
      setPlan(null)
      toast(skipped ? t('backfillDoneSkipped', { linked, created, skipped }) : t('backfillDone', { linked, created }))
      await load(); void reloadOverview()
    } catch { toast(ts('actionFailed')) } finally { setBusy(false) }
  }
  const merge = async (d: Dup) => {
    if (!window.confirm(t('mergeConfirm', { source: d.a.name, target: d.b.name }))) return
    try {
      await apiPost('/api/studio/clients/merge', { sourceId: d.a.id, targetId: d.b.id })
      toast(t('merged', { source: d.a.name, target: d.b.name }))
      await load(); void reloadOverview()
    } catch { toast(ts('actionFailed')) }
  }
  const keep = async (d: Dup) => {
    try { await apiPost('/api/studio/clients/keep', { aId: d.a.id, bId: d.b.id }); toast(t('keptSeparate')); await load() } catch { toast(ts('actionFailed')) }
  }
  const create = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const r = await apiPost<{ company?: { id: string }; id?: string }>('/api/clients', { name })
      setCreating(false); setNewName('')
      const id = r.company?.id ?? r.id
      if (id) router.push(`/admin/clients/${id}`); else await load()
    } catch { toast(ts('actionFailed')) }
  }

  const saveEdit = async () => {
    if (!editing?.name.trim()) return
    try { await apiPatch(`/api/clients/${editing.id}`, { name: editing.name.trim() }); setEditing(null); await load(); void reloadOverview() }
    catch (e) { toast(e instanceof Error && e.message && !/^HTTP \d/.test(e.message) ? e.message : ts('actionFailed')) }
  }
  const remove = async (c: ClientRow) => {
    if (!window.confirm(t('deleteConfirmShort', { name: c.name }))) return
    try { await apiDelete(`/api/clients/${c.id}`); toast(t('deleted', { name: c.name })); await load(); void reloadOverview() } catch { toast(ts('actionFailed')) }
  }

  // plan grouped by client for the preview
  const grouped = useMemo(() => {
    const m = new Map<string, { name: string; isNew: boolean; projects: string[] }>()
    for (const i of plan?.items ?? []) {
      const k = i.clientId ?? `new:${i.clientName.toLocaleLowerCase()}`
      const cur = m.get(k) ?? { name: i.clientName, isNew: i.action === 'create', projects: [] }
      cur.projects.push(i.projectTitle)
      m.set(k, cur)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [plan])

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-24 pt-5 sm:px-7">
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <Button className="ml-auto" onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />{t('newClient')}</Button>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">{t('subtitle')}</p>

      {data && data.backfill.projects > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm">
          <Building2 className="h-4 w-4 text-primary" />
          <span>{t('backfillBanner', { n: data.backfill.projects })}</span>
          <Button size="sm" className="ml-auto" onClick={openPreview} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('backfillPreview')}</Button>
        </div>
      )}
      {data?.duplicates.map((d) => (
        <div key={`${d.a.id}-${d.b.id}`} className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
          <GitMerge className="h-4 w-4 text-warning" />
          <span>{t.rich('duplicate', { a: () => <b>{d.a.name}</b>, b: () => <b>{d.b.name}</b>, n: d.a.projects })}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => keep(d)}>{t('keepSeparate')}</Button>
            <Button size="sm" onClick={() => merge(d)}>{t('merge')}</Button>
          </div>
        </div>
      ))}

      <div className="relative mb-3 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} className="pl-9" />
      </div>

      {error ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm">{t('loadFailed')} <Button size="sm" variant="outline" className="ml-2" onClick={load}>{ts('retry')}</Button></div>
      ) : !data ? (
        <div className="flex justify-center p-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">{q ? t('noMatch') : t('empty')}</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-elevation-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">{t('colClient')}</th>
                <th className="px-4 py-2.5 font-semibold">{t('colActive')}</th>
                <th className="hidden px-4 py-2.5 font-semibold md:table-cell">{t('colFeedback')}</th>
                <th className="hidden px-4 py-2.5 font-semibold md:table-cell">{t('colContacts')}</th>
                <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">{t('colLast')}</th>
                <th className="w-12 px-2 py-2.5"><span className="sr-only">{t('clientActions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="cursor-pointer border-t border-border first:border-t-0 hover:bg-background/50" onClick={() => router.push(`/admin/clients/${c.id}`)}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/clients/${c.id}`} className="flex items-center gap-2.5 font-semibold hover:text-primary" onClick={(e) => e.stopPropagation()}>
                      <span className="grid h-8 w-8 flex-none place-items-center rounded-lg text-xs font-bold text-white" style={{ background: clientColor(c.id) }}>{clientInitials(c.name)}</span>
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{c.activeProjects}</td>
                  <td className="hidden px-4 py-3 md:table-cell">{c.unreadProjects ? <span className="rounded-full bg-primary px-2 text-[11px] font-bold leading-[18px] text-primary-foreground">{t('projectsN', { n: c.unreadProjects })}</span> : <span className="text-muted-foreground">–</span>}</td>
                  <td className="hidden px-4 py-3 tabular-nums md:table-cell">{c.contacts || <span className="text-muted-foreground">–</span>}</td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{c.lastActivityAt ? format.relativeTime(new Date(c.lastActivityAt), now) : '–'}</td>
                  <td className="px-2 py-3 text-right">
                    <Menu label={t('clientActionsFor', { name: c.name })} trigger={<MoreHorizontal className="h-4 w-4" />} items={[
                      { label: t('edit'), icon: <Pencil className="h-4 w-4" />, onSelect: () => setEditing({ id: c.id, name: c.name }) },
                      { label: t('delete'), icon: <Trash2 className="h-4 w-4" />, danger: true, separatorBefore: true, onSelect: () => void remove(c) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!plan} onOpenChange={(o) => { if (!o) setPlan(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('backfillTitle')}</DialogTitle>
            <DialogDescription>{t('backfillDescription')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {grouped.map((g) => (
              <div key={g.name} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div className="text-sm"><b>{g.name}</b> <span className="text-muted-foreground">· {g.isNew ? t('newClientBadge') : t('existingClientBadge')} · {t('projectsN', { n: g.projects.length })}</span></div>
                <div className="text-xs text-muted-foreground">{g.projects.join(', ')}</div>
              </div>
            ))}
          </div>
          {plan && plan.ambiguous.length > 0 && <p className="text-xs text-muted-foreground">{t('backfillAmbiguous', { n: plan.ambiguous.length })}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlan(null)}>{ts('cancel')}</Button>
            <Button onClick={applyPreview} disabled={busy || !plan?.items.length}>{t('backfillApply', { n: plan?.items.length ?? 0 })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('editClient')}</DialogTitle><DialogDescription>{t('renameHint')}</DialogDescription></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void saveEdit() }}>
            <Input autoFocus value={editing?.name ?? ''} maxLength={200} onChange={(e) => setEditing((c) => c && { ...c, name: e.target.value })} aria-label={t('clientName')} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>{ts('cancel')}</Button>
              <Button type="submit" disabled={!editing?.name.trim()}>{ts('save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('newClient')}</DialogTitle><DialogDescription>{t('newClientHint')}</DialogDescription></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void create() }}>
            <Input autoFocus value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} placeholder={t('clientName')} aria-label={t('clientName')} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>{ts('cancel')}</Button>
              <Button type="submit" disabled={!newName.trim()}>{t('create')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
