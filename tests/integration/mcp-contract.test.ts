/**
 * HTTP contract the Resolve MCP (resolve-studio-mcp, `vitransfer.py`) relies on — PLAN.md 6.1.
 * Calls the real route handlers against the test database; only admin auth and the Redis
 * rate limiter are stubbed. Fields asserted here must never disappear (new ones may be added).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { addVersion, makeProject } from './helpers'

const admin = vi.hoisted(() => {
  // auth.ts refuses to load without token secrets; the stubbed admin never signs anything
  for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SHARE_TOKEN_SECRET']) process.env[k] ||= `test-${k}-0123456789abcdef0123456789`
  return { id: '', email: 'mcp@example.test', name: 'MCP', role: 'ADMIN' }
})
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  requireApiAdmin: vi.fn(async () => admin),
}))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  rateLimit: vi.fn(async () => null),
}))

const { GET: getProject } = await import('@/app/api/projects/[id]/route')
const { PATCH: patchVideo, GET: getVideo } = await import('@/app/api/videos/[id]/route')
const { GET: getServerInfo } = await import('@/app/api/server-info/route')

afterAll(() => prisma.$disconnect())

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const req = (method: string, body?: unknown) =>
  new NextRequest('https://review.example.test/api/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function readProject(id: string) {
  const res = await getProject(req('GET'), ctx(id))
  expect(res.status).toBe(200)
  return res.json()
}

async function patch(id: string, body: unknown) {
  const res = await patchVideo(req('PATCH', body), ctx(id))
  return { status: res.status, body: await res.json() }
}

beforeEach(async () => {
  const { user } = await makeProject()
  admin.id = user.id
})

describe('GET /api/server-info', () => {
  it('names the storage mode without auth (replaces scraping /login)', async () => {
    const body = await (await getServerInfo()).json()
    expect(body.storageProvider).toMatch(/^(local|s3)$/)
    expect(body.features).toContain('video-patch-unapproved')
  })
})

describe('GET /api/projects/:id', () => {
  it('returns the video and comment fields the MCP reads', async () => {
    const { project } = await makeProject()
    const v = await addVersion(project.id, 'Film', 1)
    await prisma.video.update({ where: { id: v.id }, data: { fps: 25 } })
    const c = await prisma.comment.create({
      data: { projectId: project.id, videoId: v.id, videoVersion: 1, timecode: '00:00:02:05', timecodeEnd: '00:00:03:00', content: 'A & B', authorName: 'Alex' },
    })
    await prisma.comment.create({
      data: { projectId: project.id, videoId: v.id, timecode: '00:00:02:05', content: 'Ok', isInternal: true, parentId: c.id, userId: admin.id },
    })

    const p = await readProject(project.id)
    for (const key of ['id', 'title', 'enableRevisions', 'maxRevisions', 'hideFeedback', 'videos', 'comments']) {
      expect(p).toHaveProperty(key)
    }
    expect(p.videos[0]).toMatchObject({
      id: v.id, name: 'Film', version: 1, versionLabel: 'v1', approved: false, fps: 25,
      originalFileName: 'Film.mov', originalFileSize: '1000',
    })
    const [comment] = p.comments
    expect(comment).toMatchObject({
      id: c.id, videoId: v.id, timecode: '00:00:02:05', timecodeEnd: '00:00:03:00', authorName: 'Alex', isInternal: false,
    })
    expect(comment.content).toBe('A & B') // stored as written (escaping happens on input), passed through
    expect(comment).toHaveProperty('createdAt')
    expect(comment).toHaveProperty('annotations')
    expect(comment.replies).toHaveLength(1)
    expect(comment.replies[0]).toMatchObject({ isInternal: true })
    expect(comment.replies[0]).toHaveProperty('user')
  })

  it('drops deleted comments; a deleted comment with live replies stays only as an empty placeholder', async () => {
    const { project } = await makeProject()
    const v = await addVersion(project.id, 'Film', 1)
    const base = { projectId: project.id, videoId: v.id, timecode: '00:00:01:00', authorName: 'Alex' }
    const gone = await prisma.comment.create({ data: { ...base, content: 'weg', deletedAt: new Date() } })
    const kept = await prisma.comment.create({ data: { ...base, content: 'bleibt' } })
    await prisma.comment.create({ data: { ...base, content: 'Antwort weg', parentId: kept.id, deletedAt: new Date() } })
    const parent = await prisma.comment.create({ data: { ...base, content: 'geheim', deletedAt: new Date() } })
    await prisma.comment.create({ data: { ...base, content: 'Antwort lebt', parentId: parent.id } })

    const { comments } = await readProject(project.id)
    const ids = comments.map((c: { id: string }) => c.id)
    expect(ids).not.toContain(gone.id)
    expect(comments.find((c: { id: string }) => c.id === kept.id).replies).toHaveLength(0)
    const placeholder = comments.find((c: { id: string }) => c.id === parent.id)
    expect(placeholder).toMatchObject({ deleted: true, content: '', authorName: null })
    expect(placeholder.replies).toHaveLength(1)
    expect(JSON.stringify(comments)).not.toContain('geheim')
  })
})

describe('PATCH /api/videos/:id {approved} (admin override)', () => {
  it('works for any version, reads back, is idempotent and reports lost approvals', async () => {
    const { project } = await makeProject()
    const v1 = await addVersion(project.id, 'Film', 1)
    const v2 = await addVersion(project.id, 'Film', 2)

    expect(await patch(v2.id, { approved: true })).toMatchObject({
      status: 200, body: { success: true, approved: true, unapproved: [] },
    })
    // approving the OLDER version takes the approval away from v2 — and says so
    expect(await patch(v1.id, { approved: true })).toMatchObject({
      status: 200, body: { success: true, approved: true, unapproved: [v2.id] },
    })
    expect((await patch(v1.id, { approved: true })).body).toMatchObject({ success: true, approved: true, unapproved: [] })

    const p = await readProject(project.id)
    const byId = Object.fromEntries(p.videos.map((v: { id: string; approved: boolean }) => [v.id, v.approved]))
    expect(byId).toEqual({ [v1.id]: true, [v2.id]: false })
    expect((await (await getVideo(req('GET'), ctx(v1.id))).json()).status).toBe('READY') // upload polling

    expect((await patch(v1.id, { approved: false })).body).toMatchObject({ success: true, approved: false, unapproved: [] })
    expect((await patch(v1.id, { approved: false })).body).toMatchObject({ success: true, approved: false, unapproved: [] })
    expect(await prisma.reviewDecision.count({ where: { videoId: v1.id, kind: 'ADMIN_OVERRIDE' } })).toBe(2)
  })

  it('rename into a group with an approved version: reports exactly what was lost', async () => {
    const { project } = await makeProject()
    const a2 = await addVersion(project.id, 'Alt', 2)
    const n1 = await addVersion(project.id, 'Neu', 1)
    await patch(a2.id, { approved: true })
    await patch(n1.id, { approved: true })
    // moved version gives way to the target group's approval, nobody else loses anything
    expect((await patch(a2.id, { name: 'Neu' })).body).toMatchObject({ approved: false, unapproved: [] })
    expect((await prisma.video.findUniqueOrThrow({ where: { id: n1.id } })).approved).toBe(true)
    // rename + approve: the target group's approved version is the one that loses it
    const a3 = await addVersion(project.id, 'Alt', 3)
    expect((await patch(a3.id, { name: 'Neu', approved: true })).body).toMatchObject({ approved: true, unapproved: [n1.id] })
  })

  it('version clash on rename is refused and changes nothing', async () => {
    const { project } = await makeProject()
    const a1 = await addVersion(project.id, 'Alt', 1)
    const n1 = await addVersion(project.id, 'Neu', 1)
    await patch(n1.id, { approved: true })
    const res = await patch(a1.id, { name: 'Neu', approved: true })
    expect(res).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } })
    const after = await prisma.video.findMany({ where: { id: { in: [a1.id, n1.id] } }, select: { id: true, name: true, approved: true } })
    expect(Object.fromEntries(after.map((v) => [v.id, [v.name, v.approved]]))).toEqual({ [a1.id]: ['Alt', false], [n1.id]: ['Neu', true] })
  })

  it('other video groups in the project keep their approval', async () => {
    const { project } = await makeProject()
    const a = await addVersion(project.id, 'A', 1)
    const b = await addVersion(project.id, 'B', 1)
    await patch(a.id, { approved: true })
    expect((await patch(b.id, { approved: true })).body.unapproved).toEqual([])
    expect((await prisma.video.findUniqueOrThrow({ where: { id: a.id } })).approved).toBe(true)
  })

  it('rejects a non-boolean approved and unknown videos', async () => {
    const { project } = await makeProject()
    const v = await addVersion(project.id, 'Film', 1)
    expect((await patch(v.id, { approved: 'yes' })).status).toBe(400)
    expect((await patch('does-not-exist', { approved: true })).status).toBe(404)
  })
})
