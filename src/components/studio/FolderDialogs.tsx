'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Folder, FolderPlus, FolderUp } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStudioData } from './StudioData'
import { useStudioActions } from './useStudioActions'
import { canNestIn, childFolders, type StudioFolder } from './views'

/** Folders in tree order with their depth, for indented pickers */
export function flatTree(folders: StudioFolder[], parentId: string | null = null, depth = 0): Array<{ f: StudioFolder; depth: number }> {
  return childFolders(folders, parentId).flatMap((f) => [{ f, depth }, ...flatTree(folders, f.id, depth + 1)])
}

const indent = (depth: number) => ({ paddingLeft: `${12 + depth * 18}px` })

/** Name a new folder or rename one. */
export function FolderNameDialog({ open, onOpenChange, initial = '', onSubmit, title }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  initial?: string
  title: string
  onSubmit: (name: string) => Promise<unknown>
}) {
  const t = useTranslations('studio')
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  // reset whenever the dialog opens or targets another folder
  useEffect(() => { if (open) setName(initial) }, [open, initial])
  const valid = name.trim().length > 0 && name.trim().length <= 80
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('folderHint')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={async (e) => { e.preventDefault(); if (!valid) return; setBusy(true); await onSubmit(name.trim()); setBusy(false); onOpenChange(false) }}>
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label={t('folderName')} placeholder={t('folderName')} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
            <Button type="submit" disabled={!valid || busy}>{t('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** "Verschieben nach …": pick a folder, "no folder", or create one. */
export function MoveDialog({ projectIds, titleText, onOpenChange, onDone }: {
  projectIds: string[] | null
  titleText: string
  onOpenChange: (o: boolean) => void
  onDone?: () => void
}) {
  const t = useTranslations('studio')
  const { folders } = useStudioData()
  const { move } = useStudioActions()
  const [newName, setNewName] = useState('')
  const go = async (folderId: string | null, name?: string) => {
    if (!projectIds) return
    onOpenChange(false)
    await move(projectIds, folderId, name)
    setNewName('')
    onDone?.()
  }
  return (
    <Dialog open={!!projectIds} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titleText}</DialogTitle>
          <DialogDescription>{t('folderHint')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border p-1">
          {flatTree(folders).map(({ f, depth }) => (
            <button key={f.id} type="button" onClick={() => go(f.id)} style={indent(depth)} className="flex w-full items-center gap-2.5 rounded-md py-2 pr-3 text-left text-sm hover:bg-accent">
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{f.name}</span>
            </button>
          ))}
          <button type="button" onClick={() => go(null)} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent">
            <span className="w-4" />{t('noFolder')}
          </button>
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) void go(null, newName.trim()) }}>
          <Input value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} placeholder={t('newFolderPlaceholder')} aria-label={t('newFolderPlaceholder')} />
          <Button type="submit" variant="outline" disabled={!newName.trim()}><FolderPlus className="mr-1.5 h-4 w-4" />{t('createAndMove')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Move a folder (with its contents) into another folder or to the top level. */
export function FolderMoveDialog({ folder, onOpenChange }: { folder: StudioFolder | null; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations('studio')
  const { folders } = useStudioData()
  const { moveFolder } = useStudioActions()
  const go = async (parentId: string | null) => {
    if (!folder) return
    onOpenChange(false)
    await moveFolder(folder.id, parentId)
  }
  return (
    <Dialog open={!!folder} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('moveFolderTitle', { name: folder?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('moveFolderHint')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border p-1">
          <button type="button" disabled={!folder?.parentId} onClick={() => go(null)} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent">
            <FolderUp className="h-4 w-4 text-muted-foreground" />{t('topLevel')}
          </button>
          {flatTree(folders).map(({ f, depth }) => {
            const ok = !!folder && f.id !== folder.parentId && canNestIn(folders, folder.id, f.id)
            return (
              <button key={f.id} type="button" disabled={!ok} onClick={() => go(f.id)} style={indent(depth)} className="flex w-full items-center gap-2.5 rounded-md py-2 pr-3 text-left text-sm hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent">
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{f.name}</span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
