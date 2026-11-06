'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useStudioActions } from './useStudioActions'

/** Confirm "Als Studio freigeben": the current version of every video counts as approved. */
export function ApproveProjectDialog({ project, onOpenChange, onDone }: {
  project: { id: string; title: string; videos: number; approved: number } | null
  onOpenChange: (o: boolean) => void
  onDone?: () => void
}) {
  const t = useTranslations('studio')
  const { approveProject } = useStudioActions()
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    if (!project) return
    setBusy(true)
    const ok = await approveProject(project.id)
    setBusy(false)
    if (ok) { onOpenChange(false); onDone?.() }
  }
  const missing = project ? project.videos - project.approved : 0
  return (
    <Dialog open={!!project} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('approveProjectTitle', { title: project?.title ?? '' })}</DialogTitle>
          <DialogDescription>{t('approveProjectHint', { n: missing })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={confirm} disabled={busy}><CheckCheck className="mr-1.5 h-4 w-4" />{t('approveProjectConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
