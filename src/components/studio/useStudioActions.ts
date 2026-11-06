'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { apiDelete, apiPatch, apiPost } from '@/lib/api-client'
import { useStudioData } from './StudioData'
import { useToast } from './Toast'

/** Folder, archive, done and approval actions with toast + undo; every action reloads the shared data. */
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

  /** "Abschließen" (completed) / "Wieder öffnen"; undo flips exactly the changed ones back */
  const setCompleted = useCallback(async (projectIds: string[], completed: boolean) => {
    try {
      const { changed, stamps } = await apiPost<{ changed: string[]; stamps: Record<string, string> }>(
        '/api/projects/complete', { items: projectIds.map((id) => ({ id })), completed })
      await reload()
      toast(t(completed ? 'completedN' : 'reopenedN', { n: changed.length }), changed.length ? async () => {
        try {
          const u = await apiPost<{ changed: string[] }>('/api/projects/complete', { items: changed.map((id) => ({ id, stamp: stamps[id] })), completed: !completed })
          await reload()
          toast(u.changed.length < changed.length ? t('undoPartial', { n: u.changed.length, skipped: changed.length - u.changed.length }) : t('undone'))
        } catch { fail() }
      } : undefined)
      return true
    } catch { fail(); return false }
  }, [reload, toast, t, fail])

  /** Studio approves the current version of every video (client agreed outside the app) */
  const approveProject = useCallback(async (projectId: string) => {
    try {
      const r = await apiPost<{ approved: number }>(`/api/studio/projects/${projectId}/approve`, {})
      await reload()
      toast(r.approved ? t('projectApproved', { n: r.approved }) : t('projectAlreadyApproved'))
      return true
    } catch { fail(); return false }
  }, [reload, toast, t, fail])

  const createFolder = useCallback(async (name: string, parentId: string | null = null) => {
    try {
      const { folder } = await apiPost<{ folder: { id: string; name: string } }>('/api/folders', { name, parentId })
      await reload()
      return folder
    } catch { fail(); return null }
  }, [reload, fail])

  const renameFolder = useCallback(async (id: string, name: string) => {
    try { await apiPatch(`/api/folders/${id}`, { name }); await reload(); return true } catch { fail(); return false }
  }, [reload, fail])

  const moveFolder = useCallback(async (id: string, parentId: string | null) => {
    try {
      await apiPatch(`/api/folders/${id}`, { parentId })
      await reload()
      const target = parentId ? folders.find((f) => f.id === parentId)?.name : t('topLevel')
      toast(t('folderMovedTo', { folder: target ?? '' }))
      return true
    } catch { fail(); return false }
  }, [reload, folders, toast, t, fail])

  const deleteFolder = useCallback(async (id: string) => {
    try { await apiDelete(`/api/folders/${id}`); await reload(); toast(t('folderDeleted')); return true } catch { fail(); return false }
  }, [reload, toast, t, fail])

  return { move, archive, restore, setCompleted, approveProject, createFolder, renameFolder, moveFolder, deleteFolder }
}
