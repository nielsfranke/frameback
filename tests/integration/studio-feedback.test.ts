import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { FeedbackError, markSeen, projectActivity, setResolved, unreadCommentIds } from '@/lib/studio-feedback'
import { addVersion, makeProject } from './helpers'

afterAll(() => prisma.$disconnect())

async function setup() {
  const { project, user } = await makeProject()
  await prisma.user.update({ where: { id: user.id }, data: { feedbackSeenBaseline: new Date(Date.now() - 60_000) } })
  const v = await addVersion(project.id, 'Film', 1)
  const base = { projectId: project.id, videoId: v.id, timecode: '00:00:02:00' }
  const a = await prisma.comment.create({ data: { ...base, content: 'Titel später', authorName: 'Alex' } })
  const b = await prisma.comment.create({ data: { ...base, content: 'Logo tauschen', authorName: 'Alex' } })
  const reply = await prisma.comment.create({ data: { ...base, content: 'Machen wir', isInternal: true, parentId: a.id } })
  return { project, user, v, a, b, reply }
}

describe('resolve', () => {
  it('marks a thread done by the studio and reopens it', async () => {
    const { user, a } = await setup()
    const done = await setResolved(a.id, user.id, true)
    expect(done.resolvedVia).toBe('STUDIO')
    expect(done.resolvedAt).toBeInstanceOf(Date)
    const open = await setResolved(a.id, user.id, false)
    expect(open.resolvedAt).toBeNull()
  })

  it('refuses replies and deleted comments', async () => {
    const { user, reply, b } = await setup()
    await expect(setResolved(reply.id, user.id, true)).rejects.toBeInstanceOf(FeedbackError)
    await prisma.comment.update({ where: { id: b.id }, data: { deletedAt: new Date() } })
    await expect(setResolved(b.id, user.id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('read state', () => {
  it('unread are the client comments not yet seen; seen is per user and idempotent', async () => {
    const { project, user, a, b } = await setup()
    expect((await unreadCommentIds(user.id, project.id)).sort()).toEqual([a.id, b.id].sort())
    expect((await markSeen(user.id, [a.id, a.id, 'does-not-exist'])).marked).toBe(1)
    expect((await markSeen(user.id, [a.id])).marked).toBe(0)
    expect(await unreadCommentIds(user.id, project.id)).toEqual([b.id])
    const other = await prisma.user.create({ data: { email: `o-${Date.now()}@example.test`, password: 'x', feedbackSeenBaseline: new Date(Date.now() - 60_000) } })
    expect((await unreadCommentIds(other.id, project.id)).length).toBe(2)
  })
})

describe('activity', () => {
  it('lists uploads, decisions and grouped client comments, newest first', async () => {
    const { project, v } = await setup()
    await prisma.reviewDecision.create({ data: { videoId: v.id, kind: 'SENT_FOR_REVIEW', actorName: 'Studio', idempotencyKey: `k-${Date.now()}` } })
    const items = await projectActivity(project.id)
    expect(items.map((i) => i.type).sort()).toEqual(['comments', 'decision', 'upload'])
    const c = items.find((i) => i.type === 'comments')
    expect(c).toMatchObject({ actor: 'Alex', count: 2, video: 'Film' })
    for (let i = 1; i < items.length; i++) expect(items[i - 1].at >= items[i].at).toBe(true)
  })
})
