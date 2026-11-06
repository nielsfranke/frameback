/**
 * Frameback studio folders: create/rename/delete, move projects in undoable
 * batches, archive/restore in bulk. Folders are studio-only and never affect access.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './db'

export class FolderError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID' | 'ALREADY_UNDONE' | 'CONFLICT', message: string) {
    super(message)
  }
}

export const MAX_FOLDER_NAME = 80

type Tx = Prisma.TransactionClient
/** Moves take a shared lock on the target folder; deleting takes an exclusive one. */
async function lockFolderShared(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Folder" WHERE id = ${id} FOR SHARE`
  if (!rows.length) throw new FolderError('NOT_FOUND', 'Folder not found')
}
async function lockFolderExclusive(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Folder" WHERE id = ${id} FOR UPDATE`
  return rows.length > 0
}
export const normalizeFolderName = (name: string) => name.replace(/\s+/g, ' ').trim()

function validName(name: string) {
  const n = normalizeFolderName(name)
  if (!n || n.length > MAX_FOLDER_NAME) throw new FolderError('INVALID', 'Folder name must be 1-80 characters')
  return n
}

export async function createFolder(name: string) {
  return prisma.folder.create({ data: { name: validName(name) }, select: { id: true, name: true } })
}

export async function renameFolder(id: string, name: string) {
  const n = validName(name)
  const res = await prisma.folder.updateMany({ where: { id }, data: { name: n } })
  if (res.count === 0) throw new FolderError('NOT_FOUND', 'Folder not found')
  return { id, name: n }
}

/** Projects in the folder fall back to "no folder" (FK ON DELETE SET NULL). */
export async function deleteFolder(id: string) {
  return prisma.$transaction(async (tx) => {
    if (!(await lockFolderExclusive(tx, id))) throw new FolderError('NOT_FOUND', 'Folder not found')
    const now = new Date()
    await tx.project.updateMany({ where: { folderId: id }, data: { folderId: null, folderChangedAt: now, folderBatchId: null } })
    const res = await tx.folder.deleteMany({ where: { id } })
    if (res.count === 0) throw new FolderError('NOT_FOUND', 'Folder not found')
    return { id }
  })
}

export interface MoveInput {
  projectIds: string[]
  /** Target folder; null = "no folder". Ignored when newFolderName is given. */
  folderId: string | null
  /** Create this folder and move into it (recorded so undo can remove it again) */
  newFolderName?: string
  /** Several new folders at once, e.g. "sort by client": projectId -> folder name */
  actorUserId?: string
}

export async function moveProjects(input: MoveInput) {
  const ids = [...new Set(input.projectIds)]
  if (ids.length === 0) throw new FolderError('INVALID', 'No projects given')
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const createdFolderIds: string[] = []
    let target = input.folderId
    if (input.newFolderName !== undefined) {
      const f = await tx.folder.create({ data: { name: validName(input.newFolderName) } })
      target = f.id
      createdFolderIds.push(f.id)
    } else if (target) {
      await lockFolderShared(tx, target)
    }
    const projects = await tx.$queryRaw<Array<{ id: string; folderId: string | null }>>`
      SELECT id, "folderId" FROM "Project" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
    if (projects.length !== ids.length) throw new FolderError('NOT_FOUND', 'Project not found')
    const moving = projects.filter((p) => p.folderId !== target)
    const batch = await tx.folderMoveBatch.create({
      data: {
        createdAt: now,
        createdFolderIds,
        actorUserId: input.actorUserId ?? null,
        items: { create: moving.map((p) => ({ projectId: p.id, prevFolderId: p.folderId, newFolderId: target })) },
      },
      select: { id: true },
    })
    if (moving.length) {
      await tx.project.updateMany({ where: { id: { in: moving.map((p) => p.id) } }, data: { folderId: target, folderChangedAt: now, folderBatchId: batch.id } })
    }
    return { batchId: batch.id, moved: moving.length, folderId: target }
  })
}

/**
 * Several targets in one batch ("Nach Kunde ordnen"): each entry moves its projects
 * into an existing folder or a newly created one. Only projects without a folder are touched.
 */
export async function moveProjectsGrouped(groups: Array<{ folderId?: string; newFolderName?: string; projectIds: string[] }>, actorUserId?: string) {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const createdFolderIds: string[] = []
    const items: Array<{ projectId: string; prevFolderId: string | null; newFolderId: string }> = []
    const allIds = [...new Set(groups.flatMap((g) => g.projectIds))]
    if (allIds.length === 0) throw new FolderError('INVALID', 'No projects given')
    const locked = await tx.$queryRaw<Array<{ id: string; folderId: string | null }>>`
      SELECT id, "folderId" FROM "Project" WHERE id IN (${Prisma.join(allIds)}) ORDER BY id FOR UPDATE`
    const current = new Map(locked.map((p) => [p.id, p.folderId]))
    for (const g of groups) {
      let target = g.folderId
      if (!target) {
        const f = await tx.folder.create({ data: { name: validName(g.newFolderName ?? '') } })
        target = f.id
        createdFolderIds.push(f.id)
      } else {
        await lockFolderShared(tx, target)
      }
      for (const pid of g.projectIds) {
        // the preview was computed for unfiled projects; anything filed since is left alone
        if (!current.has(pid) || current.get(pid) !== null) continue
        items.push({ projectId: pid, prevFolderId: null, newFolderId: target })
        current.set(pid, target)
      }
    }
    const batch = await tx.folderMoveBatch.create({
      data: { createdAt: now, createdFolderIds, actorUserId: actorUserId ?? null, items: { create: items } },
      select: { id: true },
    })
    for (const it of items) {
      await tx.project.update({ where: { id: it.projectId }, data: { folderId: it.newFolderId, folderChangedAt: now, folderBatchId: batch.id } })
    }
    // folders created for groups whose projects were all filed meanwhile stay empty: drop them
    for (const fid of createdFolderIds) {
      if (!items.some((i) => i.newFolderId === fid)) await tx.folder.delete({ where: { id: fid } })
    }
    return { batchId: batch.id, moved: items.length }
  })
}

/**
 * Undo a move batch. A project is only moved back while the batch is still the last
 * thing that placed it (Project.folderBatchId). Folders the batch created are removed
 * only if they are empty afterwards (under an exclusive folder lock, so a concurrent
 * move into them either waits and then fails, or happened before and keeps it).
 */
export async function undoMoveBatch(batchId: string) {
  return prisma.$transaction(async (tx) => {
    const [batch] = await tx.$queryRaw<Array<{ id: string; createdAt: Date; undoneAt: Date | null; createdFolderIds: string[] }>>`
      SELECT id, "createdAt", "undoneAt", "createdFolderIds" FROM "FolderMoveBatch" WHERE id = ${batchId} FOR UPDATE`
    if (!batch) throw new FolderError('NOT_FOUND', 'Batch not found')
    if (batch.undoneAt) throw new FolderError('ALREADY_UNDONE', 'Already undone')
    const items = await tx.folderMoveItem.findMany({ where: { batchId } })
    const now = new Date()
    let reverted = 0
    let skipped = 0
    if (items.length) {
      const projects = await tx.$queryRaw<Array<{ id: string; folderBatchId: string | null }>>`
        SELECT id, "folderBatchId" FROM "Project" WHERE id IN (${Prisma.join(items.map((i) => i.projectId))}) ORDER BY id FOR UPDATE`
      const byId = new Map(projects.map((p) => [p.id, p]))
      const prevIds = [...new Set(items.map((i) => i.prevFolderId).filter((x): x is string => !!x))]
      const existing = new Set((await tx.folder.findMany({ where: { id: { in: prevIds } }, select: { id: true } })).map((f) => f.id))
      for (const it of items) {
        const p = byId.get(it.projectId)
        if (!p || p.folderBatchId !== batchId) { skipped++; continue }
        const back = it.prevFolderId && existing.has(it.prevFolderId) ? it.prevFolderId : null
        if (back) await lockFolderShared(tx, back)
        await tx.project.update({ where: { id: it.projectId }, data: { folderId: back, folderChangedAt: now, folderBatchId: null } })
        reverted++
      }
    }
    for (const fid of batch.createdFolderIds) {
      if (!(await lockFolderExclusive(tx, fid))) continue
      const left = await tx.project.count({ where: { folderId: fid } })
      if (left === 0) await tx.folder.delete({ where: { id: fid } })
    }
    await tx.folderMoveBatch.update({ where: { id: batchId }, data: { undoneAt: now } })
    return { reverted, skipped }
  })
}

const RESTORABLE = new Set(['IN_REVIEW', 'APPROVED', 'SHARE_ONLY'])

/**
 * Archive projects; returns the previous status of each plus a stamp (updatedAt after
 * archiving), so undo restores exactly and never undoes a later archive/restore cycle.
 */
export async function archiveProjects(projectIds: string[]) {
  const ids = [...new Set(projectIds)]
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status::text FROM "Project" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
    const toArchive = rows.filter((r) => r.status !== 'ARCHIVED')
    const stamps: Record<string, string> = {}
    for (const r of toArchive) {
      // status only: approval metadata stays, so restoring APPROVED is lossless
      const u = await tx.project.update({ where: { id: r.id }, data: { status: 'ARCHIVED' }, select: { updatedAt: true } })
      stamps[r.id] = u.updatedAt.toISOString()
    }
    return { previous: Object.fromEntries(toArchive.map((r) => [r.id, r.status])) as Record<string, string>, stamps }
  })
}

/**
 * Restore archived projects, optionally to a given earlier status. With a stamp (undo
 * of an archive) only while the project is unchanged since that archive.
 */
export async function restoreProjects(items: Array<{ id: string; status?: string; stamp?: string }>) {
  return prisma.$transaction(async (tx) => {
    let restored = 0
    for (const it of items) {
      const status = it.status && RESTORABLE.has(it.status) ? it.status : 'IN_REVIEW'
      const res = await tx.project.updateMany({
        where: { id: it.id, status: 'ARCHIVED', ...(it.stamp ? { updatedAt: new Date(it.stamp) } : {}) },
        data: { status: status as 'IN_REVIEW' | 'APPROVED' | 'SHARE_ONLY' },
      })
      restored += res.count
    }
    return { restored }
  })
}
