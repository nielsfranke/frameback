'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiPost } from '@/lib/api-client'
import { useStudioData } from './StudioData'
import { useToast } from './Toast'

const DISMISS_KEY = 'studio:sortByClientDismissed'

/** Banner + preview: put unfiled projects into one folder per client (undoable). */
export default function SortByClient() {
  const t = useTranslations('studio.sortByClient')
  const ts = useTranslations('studio')
  const toast = useToast()
  const { projects, folders, reload } = useStudioData()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(true)
  // read after mount (server render has no storage): avoids a hydration mismatch
  useEffect(() => { try { setDismissed(localStorage.getItem(DISMISS_KEY) === '1') } catch { setDismissed(false) } }, [])

  const plan = useMemo(() => {
    const loose = projects.filter((p) => !p.archived && !p.folder && p.client)
    const by = new Map<string, { client: string; projectIds: string[]; titles: string[] }>()
    for (const p of loose) {
      const cur = by.get(p.client!.id) ?? { client: p.client!.name, projectIds: [], titles: [] }
      cur.projectIds.push(p.id); cur.titles.push(p.title)
      by.set(p.client!.id, cur)
    }
    return [...by.values()].map((g) => {
      // reuse a folder only if exactly one has the client's name
      const same = folders.filter((f) => f.name.trim().toLocaleLowerCase() === g.client.trim().toLocaleLowerCase())
      return { ...g, folderId: same.length === 1 ? same[0].id : undefined }
    }).sort((a, b) => a.client.localeCompare(b.client))
  }, [projects, folders])
  const total = plan.reduce((n, g) => n + g.projectIds.length, 0)
  const skipped = projects.filter((p) => !p.archived && !p.folder && !p.client)

  if (dismissed || total < 2) return null

  const apply = async () => {
    setBusy(true)
    try {
      const r = await apiPost<{ batchId: string; moved: number }>('/api/folders/move', {
        groups: plan.map((g) => (g.folderId ? { folderId: g.folderId, projectIds: g.projectIds } : { newFolderName: g.client, projectIds: g.projectIds })),
      })
      setOpen(false)
      await reload()
      toast(t('done', { n: r.moved }), async () => {
        try { await apiPost(`/api/folders/batches/${r.batchId}/undo`, {}); await reload(); toast(ts('undone')) } catch { toast(ts('actionFailed')) }
      })
    } catch { toast(ts('actionFailed')) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm">
        <Folder className="h-4 w-4 text-primary" />
        <span><b>{t('banner', { n: total })}</b> {t('question')}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ } }}>{t('noThanks')}</Button>
          <Button size="sm" onClick={() => setOpen(true)}>{t('preview')}</Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {plan.map((g) => (
              <div key={g.client} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-1.5 text-sm"><Folder className="h-3.5 w-3.5" /><b>{g.client}</b> <span className="text-muted-foreground">· {g.folderId ? t('existing') : t('new')} · {t('projectsN', { n: g.projectIds.length })}</span></div>
                <div className="ml-5 text-xs text-muted-foreground">{g.titles.join(', ')}</div>
              </div>
            ))}
          </div>
          {skipped.length > 0 && <p className="text-xs text-muted-foreground">{t('skipped', { n: skipped.length })}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{ts('cancel')}</Button>
            <Button onClick={apply} disabled={busy}>{t('apply', { n: plan.length })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
