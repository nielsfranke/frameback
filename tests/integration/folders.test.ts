import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import {
  archiveProjects, createFolder, deleteFolder, FolderError, MAX_FOLDER_DEPTH, moveFolder, moveProjects, moveProjectsGrouped, renameFolder, restoreProjects,
  setProjectsCompleted, undoMoveBatch, updateFolder,
} from '@/lib/folders'
import { adminOverride, approveProjectAsStudio } from '@/lib/review'
import { projectSummaries, unreadByProject } from '@/lib/studio'
import { addVersion, makeProject, state } from './helpers'

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

  it('nests folders up to the depth limit', async () => {
    let parent = (await createFolder('Kunde')).id
    for (let d = 2; d <= MAX_FOLDER_DEPTH; d++) parent = (await createFolder(`Ebene ${d}`, parent)).id
    await expect(createFolder('zu tief', parent)).rejects.toBeInstanceOf(FolderError)
    await expect(createFolder('x', 'does-not-exist')).rejects.toBeInstanceOf(FolderError)
  })

  it('moving a folder: never into itself or below itself, never too deep, back to the top level', async () => {
    const a = await createFolder('A')
    const b = await createFolder('B', a.id)
    const c = await createFolder('C', b.id)
    await expect(moveFolder(a.id, a.id)).rejects.toBeInstanceOf(FolderError)
    await expect(moveFolder(a.id, c.id)).rejects.toBeInstanceOf(FolderError)
    // A has 3 levels; under a folder that already sits 2 deep it would reach 5
    const x = await createFolder('X')
    const y = await createFolder('Y', x.id)
    await expect(moveFolder(a.id, y.id)).rejects.toBeInstanceOf(FolderError)
    await moveFolder(a.id, x.id)
    expect((await prisma.folder.findUniqueOrThrow({ where: { id: a.id } })).parentId).toBe(x.id)
    await moveFolder(b.id, null)
    expect((await prisma.folder.findUniqueOrThrow({ where: { id: b.id } })).parentId).toBeNull()
    // the database refuses a folder as its own parent even past the library
    await expect(prisma.folder.update({ where: { id: c.id }, data: { parentId: c.id } })).rejects.toThrow()
  })

  it('concurrent opposite moves cannot build a cycle', async () => {
    const a = await createFolder('P')
    const b = await createFolder('Q')
    const results = await Promise.allSettled([moveFolder(a.id, b.id), moveFolder(b.id, a.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const [fa, fb] = await Promise.all([a, b].map((f) => prisma.folder.findUniqueOrThrow({ where: { id: f.id } })))
    expect(fa.parentId === b.id && fb.parentId === a.id).toBe(false)
  })

  it('deleting a nested folder moves its projects and subfolders up one level', async () => {
    const { project } = await makeProject()
    const top = await createFolder('Oben')
    const mid = await createFolder('Mitte', top.id)
    const low = await createFolder('Unten', mid.id)
    await moveProjects({ projectIds: [project.id], folderId: mid.id })
    expect(await deleteFolder(mid.id)).toEqual({ id: mid.id, parentId: top.id })
    expect(await folderOf(project.id)).toBe(top.id)
    expect((await prisma.folder.findUniqueOrThrow({ where: { id: low.id } })).parentId).toBe(top.id)
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
  it('an old archive undo cannot undo a later archive', async () => {
    const { project } = await makeProject()
    const first = await archiveProjects([project.id])
    await restoreProjects([{ id: project.id }])
    await new Promise((res) => setTimeout(res, 5))
    await archiveProjects([project.id])
    const r = await restoreProjects([{ id: project.id, status: first.previous[project.id], stamp: first.stamps[project.id] }])
    expect(r.restored).toBe(0)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('ARCHIVED')
  })

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

describe('done (Abgeschlossen)', () => {
  it('marks done and reopens; only changed ids are reported; status and share link stay', async () => {
    const { user, project: a } = await makeProject()
    const { project: b } = await makeProject()
    expect((await setProjectsCompleted([{ id: a.id }], true)).changed).toEqual([a.id])
    expect((await setProjectsCompleted([{ id: a.id }, { id: b.id }], true)).changed).toEqual([b.id])
    const row = await prisma.project.findUniqueOrThrow({ where: { id: a.id }, select: { status: true, completedAt: true } })
    expect(row.status).toBe('IN_REVIEW')
    expect(row.completedAt).not.toBeNull()
    expect((await projectSummaries(user.id)).find((p) => p.id === a.id)?.completed).toBe(true)
    expect((await setProjectsCompleted([{ id: a.id }], false)).changed).toEqual([a.id])
    expect((await projectSummaries(user.id)).find((p) => p.id === a.id)?.completed).toBe(false)
  })

  it('undo only reverts projects nobody changed since; parallel calls report a project once', async () => {
    const { project } = await makeProject()
    const first = await setProjectsCompleted([{ id: project.id }], true)
    await new Promise((r) => setTimeout(r, 5))
    // someone else reopens and marks it done again
    await setProjectsCompleted([{ id: project.id }], false)
    await setProjectsCompleted([{ id: project.id }], true)
    const undo = await setProjectsCompleted([{ id: project.id, stamp: first.stamps[project.id] }], false)
    expect(undo.changed).toEqual([])
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).completedAt).not.toBeNull()

    await setProjectsCompleted([{ id: project.id }], false)
    const both = await Promise.all([setProjectsCompleted([{ id: project.id }], true), setProjectsCompleted([{ id: project.id }], true)])
    expect(both.flatMap((r) => r.changed)).toEqual([project.id])
  })

  it('rename + move in one request: an invalid name leaves the folder where it was', async () => {
    const a = await createFolder('Quelle')
    const b = await createFolder('Ziel')
    await expect(updateFolder(a.id, { name: '   ', parentId: b.id })).rejects.toBeInstanceOf(FolderError)
    expect((await prisma.folder.findUniqueOrThrow({ where: { id: a.id } })).parentId).toBeNull()
    expect(await updateFolder(a.id, { name: 'Neu', parentId: b.id })).toEqual({ id: a.id, name: 'Neu', parentId: b.id })
  })
})

describe('studio approves a whole project', () => {
  it('approves the current version of every video, moves an older approval, skips processing-only videos', async () => {
    const { user, project } = await makeProject()
    const a1 = await addVersion(project.id, 'Spot', 1)
    const a2 = await addVersion(project.id, 'Spot', 2)
    const b1 = await addVersion(project.id, 'Teaser', 1)
    await addVersion(project.id, 'Making-of', 1, 'PROCESSING')
    // the client had approved v1 of Spot before v2 came in
    await adminOverride({ videoId: a1.id, approved: true, adminUserId: user.id })

    const r = await approveProjectAsStudio({ projectId: project.id, adminUserId: user.id, actorName: 'Studio' })
    expect(new Set(r.approvedIds)).toEqual(new Set([a2.id, b1.id]))
    expect(await state(a1.id)).toEqual({ reviewState: 'DRAFT', approved: false })
    expect(await state(a2.id)).toEqual({ reviewState: 'APPROVED', approved: true })
    expect(await state(b1.id)).toEqual({ reviewState: 'APPROVED', approved: true })
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('APPROVED')
    expect(await prisma.reviewDecision.count({ where: { videoId: { in: [a2.id, b1.id] }, kind: 'ADMIN_OVERRIDE' } })).toBeGreaterThanOrEqual(2)
    // again: nothing left to do
    expect((await approveProjectAsStudio({ projectId: project.id, adminUserId: user.id })).approvedIds).toEqual([])
  })

  it('an archived project stays archived', async () => {
    const { user, project } = await makeProject()
    await addVersion(project.id, 'Spot', 1)
    await prisma.project.update({ where: { id: project.id }, data: { status: 'ARCHIVED' } })
    await approveProjectAsStudio({ projectId: project.id, adminUserId: user.id })
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe('ARCHIVED')
  })
})
