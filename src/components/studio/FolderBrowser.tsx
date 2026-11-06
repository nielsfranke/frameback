'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronRight, Folder, FolderInput, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useStudioData } from './StudioData'
import { useStudioActions } from './useStudioActions'
import { Menu } from './Menu'
import { FolderMoveDialog, FolderNameDialog } from './FolderDialogs'
import { canNestIn, childFolders, countInTree, DRAG_TYPE, folderPath, FOLDER_DRAG_TYPE, viewHref, type StudioFolder } from './views'

/** Drop projects (move) or a folder (nest) onto a target; null = top level / no folder */
function useDrop() {
  const { folders } = useStudioData()
  const { move, moveFolder } = useStudioActions()
  const [over, setOver] = useState<string | null>(null)
  const props = (key: string, folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = e.dataTransfer.types
      if (types.includes(DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(key) }
    },
    onDragLeave: () => setOver((d) => (d === key ? null : d)),
    onDrop: (e: React.DragEvent) => {
      setOver(null)
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      const folderRaw = e.dataTransfer.getData(FOLDER_DRAG_TYPE)
      if (!raw && !folderRaw) return
      e.preventDefault()
      e.stopPropagation()
      if (folderRaw) {
        const f = folders.find((x) => x.id === folderRaw)
        if (f && f.id !== folderId && (f.parentId ?? null) !== folderId && canNestIn(folders, f.id, folderId)) void moveFolder(f.id, folderId)
        return
      }
      try { void move(JSON.parse(raw) as string[], folderId) } catch { /* foreign payload */ }
    },
  })
  return { props, ring: (key: string) => (over === key ? 'ring-2 ring-primary bg-primary/10' : '') }
}

/** "Ordner / Kunde / 2026" – every step is a link and a drop target */
export function FolderBreadcrumb({ folderId }: { folderId: string | null }) {
  const t = useTranslations('studio')
  const { folders } = useStudioData()
  const drop = useDrop()
  const path = folderPath(folders, folderId)
  if (!folderId) return null
  return (
    <nav aria-label={t('folderPath')} className="mb-1 flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
      <Link href={viewHref({ kind: 'nofolder' })} className={`rounded px-1 hover:text-foreground ${drop.ring('root')}`} {...drop.props('root', null)}>{t('folders')}</Link>
      {path.slice(0, -1).map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1">
          <ChevronRight className="h-3 w-3" aria-hidden />
          <Link href={viewHref({ kind: 'folder', id: f.id })} className={`rounded px-1 hover:text-foreground ${drop.ring(f.id)}`} {...drop.props(f.id, f.id)}>{f.name}</Link>
        </span>
      ))}
    </nav>
  )
}

/** Subfolders of `parentId` as tiles: open, drop projects/folders onto them, rename/move/delete. */
export default function FolderBrowser({ parentId }: { parentId: string | null }) {
  const t = useTranslations('studio')
  const router = useRouter()
  const { projects, folders } = useStudioData()
  const { renameFolder, deleteFolder } = useStudioActions()
  const drop = useDrop()
  const [renaming, setRenaming] = useState<StudioFolder | null>(null)
  const [moving, setMoving] = useState<StudioFolder | null>(null)
  const kids = childFolders(folders, parentId)
  if (kids.length === 0) return null
  return (
    <section aria-label={t('subfolders')} className="mb-5">
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">{parentId ? t('subfolders') : t('folders')}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
        {kids.map((f) => {
          const n = countInTree(projects, folders, f.id)
          const sub = childFolders(folders, f.id).length
          return (
            <div
              key={f.id}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData(FOLDER_DRAG_TYPE, f.id); e.dataTransfer.effectAllowed = 'move' }}
              onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button')) router.push(viewHref({ kind: 'folder', id: f.id })) }}
              className={`group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 shadow-elevation-sm hover:border-primary/40 ${drop.ring(f.id)}`}
              {...drop.props(f.id, f.id)}
            >
              <Folder className="h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <Link href={viewHref({ kind: 'folder', id: f.id })} className="block truncate text-sm font-semibold hover:text-primary">{f.name}</Link>
                <div className="text-xs text-muted-foreground">
                  {t('projectsN', { n })}{sub > 0 && ` · ${t('foldersN', { n: sub })}`}
                </div>
              </div>
              <Menu
                label={t('folderActionsFor', { name: f.name })}
                trigger={<MoreHorizontal className="h-4 w-4" />}
                items={[
                  { label: t('renameFolder'), icon: <Pencil className="h-4 w-4" />, onSelect: () => setRenaming(f) },
                  { label: t('moveTo'), icon: <FolderInput className="h-4 w-4" />, onSelect: () => setMoving(f) },
                  { label: t('deleteFolder'), icon: <Trash2 className="h-4 w-4" />, danger: true, separatorBefore: true, onSelect: async () => {
                    if (window.confirm(t('deleteFolderConfirm', { name: f.name }))) await deleteFolder(f.id)
                  } },
                ]}
              />
            </div>
          )
        })}
      </div>
      <FolderNameDialog open={!!renaming} onOpenChange={(o) => { if (!o) setRenaming(null) }} initial={renaming?.name ?? ''} title={t('renameFolder')} onSubmit={(name) => renameFolder(renaming!.id, name)} />
      <FolderMoveDialog folder={moving} onOpenChange={(o) => { if (!o) setMoving(null) }} />
    </section>
  )
}
