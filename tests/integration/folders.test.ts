import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import {
  archiveProjects, createFolder, deleteFolder, FolderError, moveProjects, moveProjectsGrouped, renameFolder, restoreProjects, undoMoveBatch,
} from '@/lib/folders'
import { projectSummaries, unreadByProject } from '@/lib/studio'
import { addVersion, makeProject } from './helpers'

afterAll(() => prisma.$disconnect())

const folderOf = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id }, select: { folderId: true } })).folderId

describe('folders', () => {
  it('rejects blank or too long names and normalises whitespace', async () => {
    await expect(createFolder('   ')).rejects.toBeInstanceOf(FolderError)
    await expect(createFolder('x'.repeat(81))).rejects.toBeInstanceOf(FolderError)
    const f = await createFolder('  Messen   2026 ')
    expect(f.name).toBe('Messen 2026')
    expect((await renameFolder(f.id, 'Messen 2027')).name).toBe('Messen 2027')
  })

  it('a folder cannot be nested yet (database constraint)', async () => {
    const a = await createFolder('A')
    await expect(prisma.folder.create({ data: { name: 'B', parentId: a.id } })).rejects.toThrow()
  })

  it('deleting a folder leaves its projects without a folder', async () => {
    const { project } = await makeProject()
    const f = await createFolder('Weg')
    await moveProjects({ projectIds: [project.id], folderId: f.id })
    await deleteFolder(f.id)
    expect(await folderOf(project.id)).toBeNull()
  })
})

describe('move + undo', () => {
  it('moves into a new folder and undo removes that folder again', async () => {
    const { project: a } = await makeProject()
    const { project: b } = await makeProject()
    const r = await moveProjects({ projectIds: [a.id, b.id], folderId: null, newFolderName: 'Nordwind AG' })
    expect(r.moved).toBe(2)
    expect(await folderOf(a.id)).toBe(r.folderId)
    const u = await undoMoveBatch(r.batchId)
    expect(u).toEqual({ reverted: 2, skipped: 0 })
    expect(await folderOf(a.id)).toBeNull()
    expect(await prisma.folder.findUnique({ where: { id: r.folderId! } })).toBeNull()
  })

  it('undo leaves projects alone that were moved by hand afterwards', async () => {
    const { project: a } = await makeProject()
    const { project: b } = await makeProject()
    const f1 = await createFolder('Eins')
    const f2 = await createFolder('Zwei')
    const r = await moveProjects({ projectIds: [a.id, b.id], folderId: f1.id })
    await new Promise((res) => setTimeout(res, 5))
    await moveProjects({ projectIds: [b.id], folderId: f2.id })
    const u = await undoMoveBatch(r.batchId)
    expect(u).toEqual({ reverted: 1, skipped: 1 })
    expect(await folderOf(a.id)).toBeNull()
    expect(await folderOf(b.id)).toBe(f2.id)
  })

  it('undo also skips a project moved away and back again', async () => {
    const { project: a } = await makeProject()
    const f1 = await createFolder('Hin')
    const f2 = await createFolder('Her')
    const r = await moveProjects({ projectIds: [a.id], folderId: f1.id })
    await new Promise((res) => setTimeout(res, 5))
    await moveProjects({ projectIds: [a.id], folderId: f2.id })
    await new Promise((res) => setTimeout(res, 5))
    await moveProjects({ projectIds: [a.id], folderId: f1.id })
    expect(await undoMoveBatch(r.batchId)).toEqual({ reverted: 0, skipped: 1 })
    expect(await folderOf(a.id)).toBe(f1.id)
  })

  it('a batch can be undone only once', async () => {
    const { project } = await makeProject()
    const f = await createFolder('Einmal')
    const r = await moveProjects({ projectIds: [project.id], folderId: f.id })
    await undoMoveBatch(r.batchId)
    await expect(undoMoveBatch(r.batchId)).rejects.toMatchObject({ code: 'ALREADY_UNDONE' })
  })

  it('undo restores the previous folder, or none if it was deleted meanwhile', async () => {
    const { project } = await makeProject()
    const old = await createFolder('Alt')
    const target = await createFolder('Neu')
    await moveProjects({ projectIds: [project.id], folderId: old.id })
    const r = await moveProjects({ projectIds: [project.id], folderId: target.id })
    await deleteFolder(old.id)
    await undoMoveBatch(r.batchId)
    expect(await folderOf(project.id)).toBeNull()
  })

  it('grouped move only files projects that are still without a folder', async () => {
    const { project: a } = await makeProject()
    const { project: b } = await makeProject()
    const keep = await createFolder('Schon einsortiert')
    await moveProjects({ projectIds: [b.id], folderId: keep.id })
    const r = await moveProjectsGrouped([{ newFolderName: 'Contoso AG', projectIds: [a.id, b.id] }])
    expect(r.moved).toBe(1)
    expect(await folderOf(b.id)).toBe(keep.id)
    await undoMoveBatch(r.batchId)
    expect(await folderOf(a.id)).toBeNull()
  })
})

describe('archive', () => {
  it('archiving keeps the earlier status for a lossless restore', async () => {
    const { project } = await makeProject()
    await prisma.project.update({ where: { id: project.id }, data: { status: 'APPROVED', approvedAt: new Date() } })
    const { previous } = await archiveProjects([project.id])
    expect(previous[project.id]).toBe('APPROVED')
    await restoreProjects([{ id: project.id, status: previous[project.id] }])
    const p = await prisma.project.findUniqueOrThrow({ where: { id: project.id } })
    expect(p.status).toBe('APPROVED')
    expect(p.approvedAt).not.toBeNull()
  })

  it('restore never touches a project that is not archived', async () => {
    const { project } = await makeProject()
    await restoreProjects([{ id: project.id, status: 'APPROVED' }])
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('IN_REVIEW')
  })
})

describe('unread feedback', () => {
  it('counts only new client comments the user has not seen', async () => {
    const { project, user } = await makeProject()
    const v = await addVersion(project.id, 'Film', 1)
    await prisma.user.update({ where: { id: user.id }, data: { feedbackSeenBaseline: new Date(Date.now() - 60_000) } })
    const before = new Date(Date.now() - 120_000)
    const base = { projectId: project.id, videoId: v.id, timecode: '00:00:01:00' }
    await prisma.comment.create({ data: { ...base, content: 'vor der Baseline', createdAt: before } })
    const fresh = await prisma.comment.create({ data: { ...base, content: 'neu' } })
    await prisma.comment.create({ data: { ...base, content: 'auch neu' } })
    await prisma.comment.create({ data: { ...base, content: 'Studio', isInternal: true } })
    await prisma.comment.create({ data: { ...base, content: 'Studio-Nutzer', userId: user.id } })
    await prisma.comment.create({ data: { ...base, content: 'gelöscht', deletedAt: new Date() } })
    expect((await unreadByProject(user.id, [project.id])).get(project.id)).toBe(2)
    await prisma.studioCommentSeen.create({ data: { userId: user.id, commentId: fresh.id } })
    expect((await unreadByProject(user.id, [project.id])).get(project.id)).toBe(1)
  })
})

describe('overview summary', () => {
  it('derives progress from the current version of each video', async () => {
    const { project, user } = await makeProject()
    const a1 = await addVersion(project.id, 'A', 1)
    await prisma.video.update({ where: { id: a1.id }, data: { reviewState: 'APPROVED' } })
    await addVersion(project.id, 'A', 2) // newer draft is current
    const b = await addVersion(project.id, 'B', 1)
    await prisma.video.update({ where: { id: b.id }, data: { reviewState: 'IN_REVIEW' } })
    const c = await addVersion(project.id, 'C', 1)
    await prisma.video.update({ where: { id: c.id }, data: { approved: true } })
    await addVersion(project.id, 'D', 1, 'PROCESSING') // not ready: not counted
    const row = (await projectSummaries(user.id)).find((p) => p.id === project.id)!
    expect(row).toMatchObject({ videos: 3, approved: 1, waiting: 1, changes: 0 })
    expect(row.last?.type).toBe('upload')
  })
})
