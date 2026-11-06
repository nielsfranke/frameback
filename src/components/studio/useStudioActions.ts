'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { apiDelete, apiPatch, apiPost } from '@/lib/api-client'
import { useStudioData } from './StudioData'
import { useToast } from './Toast'

/** Folder and archive actions with toast + undo; every action reloads the shared data. */
export function useStudioActions() {
  const t = useTranslations('studio')
  const toast = useToast()
  const { reload, folders } = useStudioData()
  const fail = useCallback(() => toast(t('actionFailed')), [toast, t])

  const move = useCallback(async (projectIds: string[], folderId: string | null, newFolderName?: string) => {
    try {
      const r = await apiPost<{ batchId: string; moved: number; folderId: string | null }>('/api/folders/move', { projectIds, folderId, newFolderName })
      await reload()
      const target = newFolderName ?? (folderId ? folders.find((f) => f.id === folderId)?.name : null) ?? t('noFolder')
      toast(t('movedTo', { n: r.moved, folder: target }), async () => {
        try {
          const u = await apiPost<{ reverted: number; skipped: number }>(`/api/folders/batches/${r.batchId}/undo`, {})
          await reload()
          toast(u.skipped ? t('undoPartial', { n: u.reverted, skipped: u.skipped }) : t('undone'))
        } catch { fail() }
      })
      return r
    } catch { fail(); return null }
  }, [reload, folders, toast, t, fail])

  const archive = useCallback(async (projectIds: string[]) => {
    try {
      const { previous, stamps } = await apiPost<{ previous: Record<string, string>; stamps: Record<string, string> }>('/api/projects/archive', { projectIds })
      await reload()
      const items = Object.entries(previous).map(([id, status]) => ({ id, status, stamp: stamps[id] }))
      toast(t('archived', { n: items.length }), items.length ? async () => {
        try { await apiPost('/api/projects/restore', { items }); await reload(); toast(t('undone')) } catch { fail() }
      } : undefined)
    } catch { fail() }
  }, [reload, toast, t, fail])

  const restore = useCallback(async (projectIds: string[]) => {
    try {
      await apiPost('/api/projects/restore', { items: projectIds.map((id) => ({ id })) })
      await reload()
      toast(t('restored', { n: projectIds.length }))
    } catch { fail() }
  }, [reload, toast, t, fail])

  const createFolder = useCallback(async (name: string) => {
    try {
      const { folder } = await apiPost<{ folder: { id: string; name: string } }>('/api/folders', { name })
      await reload()
      return folder
    } catch { fail(); return null }
  }, [reload, fail])

  const renameFolder = useCallback(async (id: string, name: string) => {
    try { await apiPatch(`/api/folders/${id}`, { name }); await reload(); return true } catch { fail(); return false }
  }, [reload, fail])

  const deleteFolder = useCallback(async (id: string) => {
    try { await apiDelete(`/api/folders/${id}`); await reload(); toast(t('folderDeleted')); return true } catch { fail(); return false }
  }, [reload, toast, t, fail])

  return { move, archive, restore, createFolder, renameFolder, deleteFolder }
}
