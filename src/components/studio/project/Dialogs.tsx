'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Copy, Eye, Send, Settings2, Share2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import VideoUpload from '@/components/VideoUpload'
import { apiPatch, apiPost } from '@/lib/api-client'
import { useToast } from '../Toast'
import type { Group } from './groups'

export function SendForReviewDialog({ group, smtpConfigured, onOpenChange, onDone }: {
  group: Group | null
  smtpConfigured: boolean
  onOpenChange: (o: boolean) => void
  onDone: () => void
}) {
  const t = useTranslations('studio.project')
  const toast = useToast()
  const v = group?.current
  const [note, setNote] = useState('')
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (v) { setNote(v.versionNote ?? ''); setNotify(smtpConfigured) } }, [v, smtpConfigured])
  if (!group || !v) return null
  const send = async () => {
    setBusy(true)
    try {
      await apiPost(`/api/videos/${v.id}/review-request`, { versionNote: note, notifyClients: smtpConfigured && notify })
      onOpenChange(false)
      toast(t('sentToast'))
      onDone()
    } catch {
      toast(t('sendFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('sendTitle', { version: `v${v.version}`, name: group.name })}</DialogTitle>
          <DialogDescription>{t('sendDescription')}</DialogDescription>
        </DialogHeader>
        <label htmlFor="fb-send-note" className="text-sm font-semibold">{t('noteLabel')} <span className="font-normal text-muted-foreground">{t('noteHint')}</span></label>
        <Textarea id="fb-send-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('notePlaceholder')} rows={3} />
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={smtpConfigured && notify} disabled={!smtpConfigured} onChange={(e) => setNotify(e.target.checked)} />
          <span>
            {t('notifyClients')}
            {!smtpConfigured && <span className="block text-xs text-muted-foreground">{t('noSmtp')} <Link href="/admin/settings" className="text-primary underline">{t('setUp')}</Link></span>}
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('cancel')}</Button>
          <Button onClick={send} disabled={busy}><Send className="mr-1.5 h-4 w-4" />{t('send')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function NewVersionDialog({ projectId, group, file, onOpenChange, onUploaded }: {
  projectId: string
  group: Group | null
  file?: File | null
  onOpenChange: (o: boolean) => void
  onUploaded: () => void
}) {
  const t = useTranslations('studio.project')
  if (!group) return null
  const next = (group.versions[0]?.version ?? 0) + 1
  const roundOpen = group.state === 'waiting' || group.state === 'changes'
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('newVersionTitle', { name: group.name })}</DialogTitle>
          <DialogDescription>
            {t('newVersionDescription', { version: `v${next}` })}
            {roundOpen && ` ${t('newVersionEndsRound', { version: `v${next - 1}` })}`}
          </DialogDescription>
        </DialogHeader>
        <VideoUpload projectId={projectId} videoName={group.name} initialFile={file ?? null} onUploadComplete={() => { onUploaded(); onOpenChange(false) }} />
      </DialogContent>
    </Dialog>
  )
}

export function RenameVideoDialog({ group, onOpenChange, onDone }: { group: Group | null; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const t = useTranslations('studio.project')
  const toast = useToast()
  const [name, setName] = useState('')
  useEffect(() => { if (group) setName(group.name) }, [group])
  if (!group) return null
  const valid = name.trim().length > 0 && name.trim() !== group.name
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t('renameTitle')}</DialogTitle><DialogDescription>{t('renameHint')}</DialogDescription></DialogHeader>
        <form onSubmit={async (e) => {
          e.preventDefault(); if (!valid) return
          try { await apiPatch('/api/videos/batch', { videoIds: group.versions.map((v) => v.id), name: name.trim() }); onOpenChange(false); onDone() } catch { toast(t('actionFailed')) }
        }}>
          <Input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-label={t('renameTitle')} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
            <Button type="submit" disabled={!valid}>{t('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** "Teilen": link, client view, access and content at a glance; details live in settings. */
export function SharePopover({ project, shareUrl }: { project: { id: string; authMode?: string; sharePassword?: boolean | string | null; photoOnlyShare?: boolean; guestMode?: boolean }; shareUrl: string }) {
  const t = useTranslations('studio.project')
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const access = project.authMode === 'NONE' ? t('accessOpen') : project.authMode === 'PASSWORD' ? t('accessPassword') : t('accessOther')
  const content = project.photoOnlyShare ? t('contentPhotos') : t('contentVideos')
  return (
    <div ref={root} className="relative">
      <Button variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog"><Share2 className="mr-1.5 h-4 w-4" />{t('share')}</Button>
      {open && (
        <div role="dialog" aria-label={t('share')} className="absolute right-0 top-full z-50 mt-2 w-[min(380px,calc(100vw-24px))] rounded-xl border border-border bg-card p-4 shadow-elevation-lg animate-in fade-in zoom-in-95">
          <h3 className="font-semibold">{t('shareTitle')}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{project.authMode === 'NONE' ? t('shareHintOpen') : t('shareHintProtected')}</p>
          <div className="mt-3 flex gap-2">
            <Input readOnly value={shareUrl} aria-label={t('shareLink')} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" size="icon" aria-label={t('copyLink')} onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); toast(t('linkCopied')) } catch { toast(t('actionFailed')) } }}><Copy className="h-4 w-4" /></Button>
          </div>
          <dl className="mt-3 divide-y divide-border border-t border-border text-sm">
            <div className="flex justify-between py-2.5"><dt>{t('access')}</dt><dd className="font-semibold">{access}</dd></div>
            <div className="flex justify-between py-2.5"><dt>{t('content')}</dt><dd className="font-semibold">{content}</dd></div>
          </dl>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button asChild variant="outline" className="flex-1"><a href={shareUrl} target="_blank" rel="noopener noreferrer"><Eye className="mr-1.5 h-4 w-4" />{t('viewAsClient')}</a></Button>
            <Button asChild variant="outline" className="flex-1"><Link href={`/admin/projects/${project.id}/settings`}><Settings2 className="mr-1.5 h-4 w-4" />{t('changeAccess')}</Link></Button>
          </div>
        </div>
      )}
    </div>
  )
}
