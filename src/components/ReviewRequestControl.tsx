'use client'

/**
 * Frameback: review state of the current version + "Zur Freigabe senden" / "Zurückziehen".
 * Clients can only approve a version after the studio sent it for approval
 * (enforced server-side in src/lib/review.ts when FEATURE_REVIEW_FLOW is on).
 */
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Send, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiDelete, apiPost } from '@/lib/api-client'

type ReviewState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'

const badgeClass: Record<ReviewState, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  IN_REVIEW: 'bg-primary/10 text-primary',
  CHANGES_REQUESTED: 'bg-warning-visible text-warning',
  APPROVED: 'bg-success-visible text-success',
}

interface Props {
  videoId: string
  versionLabel: string
  reviewState: ReviewState
  versionNote?: string | null
  onChanged?: () => void
}

export default function ReviewRequestControl({ videoId, versionLabel, reviewState, versionNote, onChanged }: Props) {
  const t = useTranslations('review')
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState(versionNote ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await apiPost(`/api/videos/${videoId}/review-request`, { versionNote: note })
      setOpen(false)
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async () => {
    if (!confirm(t('withdrawConfirm', { version: versionLabel }))) return
    setBusy(true)
    try {
      await apiDelete(`/api/videos/${videoId}/review-request`)
      onChanged?.()
    } catch (e) {
      alert(e instanceof Error ? e.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass[reviewState]}`}>
        {t(`state.${reviewState}`)}
      </span>
      {(reviewState === 'DRAFT' || reviewState === 'CHANGES_REQUESTED') && (
        <Button size="sm" className="h-7" onClick={() => { setNote(versionNote ?? ''); setError(null); setOpen(true) }} disabled={busy}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {t('send')}
        </Button>
      )}
      {reviewState === 'IN_REVIEW' && (
        <>
          <span className="text-xs text-muted-foreground">{t('waiting')}</span>
          <Button size="sm" variant="outline" className="h-7" onClick={withdraw} disabled={busy}>
            <Undo2 className="mr-1.5 h-3.5 w-3.5" />
            {t('withdraw')}
          </Button>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sendTitle', { version: versionLabel })}</DialogTitle>
            <DialogDescription>{t('sendDescription')}</DialogDescription>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor={`note-${videoId}`}>{t('noteLabel')}</label>
          <Textarea
            id={`note-${videoId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={t('notePlaceholder')}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t('cancel')}</Button>
            <Button onClick={send} disabled={busy}>
              <Send className="mr-1.5 h-4 w-4" />
              {t('sendConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
