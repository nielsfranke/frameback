import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashViewerKey } from '@/lib/review'
import { applySoftDelete, readViewerKey, setViewerCookie, VIEWER_COOKIE, viewerKeyFor } from '@/lib/comment-ownership'
import { CommentMutationError, editComment, restoreComment, softDeleteComment } from '@/lib/comment-mutations'
import { addVersion, makeProject } from './helpers'

beforeAll(() => { process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-viewer-signing' })
afterAll(() => prisma.$disconnect())

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const annaHash = hashViewerKey(KEY_A)

async function setup() {
  const { project, user } = await makeProject()
  const v = await addVersion(project.id, 'Film', 1)
  const own = await prisma.comment.create({
    data: { projectId: project.id, videoId: v.id, timecode: '00:00:12:00', content: 'Musik zu laut', authorKeyHash: annaHash },
  })
  const studio = await prisma.comment.create({
    data: { projectId: project.id, videoId: v.id, timecode: '00:00:12:00', content: 'Machen wir', isInternal: true, parentId: own.id },
  })
  return { project, user, v, own, studio }
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(CommentMutationError)
  await expect(p).rejects.toMatchObject({ code })
}

describe('browser key (vt_viewer)', () => {
  it('accepts only keys signed by this server', () => {
    const res = setViewerCookie(NextResponse.json({}), KEY_A)
    const cookie = res.cookies.get(VIEWER_COOKIE)!.value
    const signed = new NextRequest('http://x/', { headers: { cookie: `${VIEWER_COOKIE}=${cookie}` } })
    expect(readViewerKey(signed)).toBe(KEY_A)
    const planted = new NextRequest('http://x/', { headers: { cookie: `${VIEWER_COOKIE}=${KEY_A}.${'0'.repeat(32)}` } })
    expect(readViewerKey(planted)).toBeNull()
    expect(viewerKeyFor(planted).isNew).toBe(true)
  })

  it('cookie is httpOnly, lax, path=/', () => {
    const res = setViewerCookie(NextResponse.json({}), KEY_A)
    const c = res.cookies.get(VIEWER_COOKIE)!
    expect(c.httpOnly).toBe(true)
    expect(c.sameSite).toBe('lax')
    expect(c.path).toBe('/')
  })
})

describe('edit', () => {
  it('the author (same browser key) can edit; the edit is marked', async () => {
    const { project, own } = await setup()
    const r = await editComment({ commentId: own.id, content: 'Musik etwas leiser', actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id })
    expect(r.content).toBe('Musik etwas leiser')
    expect(r.editedAt).toBeInstanceOf(Date)
  })

  it('another browser, a missing key or a studio comment is forbidden for clients', async () => {
    const { project, own, studio } = await setup()
    await expectCode(editComment({ commentId: own.id, content: 'x', actor: { kind: 'client', viewerKeyHash: hashViewerKey(KEY_B) }, projectId: project.id }), 'FORBIDDEN')
    await expectCode(editComment({ commentId: own.id, content: 'x', actor: { kind: 'client', viewerKeyHash: null }, projectId: project.id }), 'FORBIDDEN')
    await expectCode(editComment({ commentId: studio.id, content: 'x', actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id }), 'FORBIDDEN')
  })

  it('a comment of another project looks like "not found" (no probing across shares)', async () => {
    const { own } = await setup()
    const other = await makeProject()
    await expectCode(editComment({ commentId: own.id, content: 'x', actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: other.project.id }), 'NOT_FOUND')
  })

  it('admins may edit any comment; content is sanitized; empty is rejected', async () => {
    const { user, studio } = await setup()
    const r = await editComment({ commentId: studio.id, content: 'Erledigt <script>alert(1)</script>', actor: { kind: 'admin', userId: user.id } })
    expect(r.content).not.toContain('<script>')
    await expectCode(editComment({ commentId: studio.id, content: '   ', actor: { kind: 'admin', userId: user.id } }), 'INVALID')
  })
})

describe('delete and restore', () => {
  it('soft delete keeps a placeholder while the studio reply exists; restore brings it back', async () => {
    const { project, own } = await setup()
    await softDeleteComment({ commentId: own.id, actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id })
    const raw = await prisma.comment.findMany({ where: { projectId: project.id, parentId: null }, include: { replies: true } })
    const visible = applySoftDelete(raw) as Array<{ deleted?: boolean; content: string; replies: unknown[] }>
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ deleted: true, content: '' })
    expect(visible[0].replies).toHaveLength(1)

    await expectCode(editComment({ commentId: own.id, content: 'x', actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id }), 'DELETED')
    await restoreComment({ commentId: own.id, actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id })
    const back = await prisma.comment.findUniqueOrThrow({ where: { id: own.id } })
    expect(back.deletedAt).toBeNull()
    expect(back.content).toBe('Musik zu laut')
  })

  it('a deleted comment without replies disappears; deleting twice is harmless', async () => {
    const { project, v } = await setup()
    const lone = await prisma.comment.create({ data: { projectId: project.id, videoId: v.id, timecode: '00:00:01:00', content: 'Tippfehler', authorKeyHash: annaHash } })
    await softDeleteComment({ commentId: lone.id, actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id })
    const again = await softDeleteComment({ commentId: lone.id, actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id })
    expect(again.alreadyDeleted).toBe(true)
    const raw = await prisma.comment.findMany({ where: { projectId: project.id, parentId: null }, include: { replies: true } })
    expect(applySoftDelete(raw).find((c) => c.id === lone.id)).toBeUndefined()
  })

  it('deleted studio replies disappear from the thread', async () => {
    const { project, user, studio } = await setup()
    await softDeleteComment({ commentId: studio.id, actor: { kind: 'admin', userId: user.id } })
    const raw = await prisma.comment.findMany({ where: { projectId: project.id, parentId: null }, include: { replies: true } })
    expect((applySoftDelete(raw)[0] as { replies: unknown[] }).replies).toHaveLength(0)
  })
})

describe('codex review fixes (comments)', () => {
  it('a comment removed by the studio cannot be restored by the client', async () => {
    const { project, user, own } = await setup()
    await softDeleteComment({ commentId: own.id, actor: { kind: 'admin', userId: user.id } })
    await expectCode(restoreComment({ commentId: own.id, actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id }), 'FORBIDDEN')
    await restoreComment({ commentId: own.id, actor: { kind: 'admin', userId: user.id } })
  })

  it('placeholders carry no author, user or key hash', async () => {
    const { project, user, own } = await setup()
    await prisma.comment.update({ where: { id: own.id }, data: { userId: user.id, authorName: 'Anna' } })
    await softDeleteComment({ commentId: own.id, actor: { kind: 'client', viewerKeyHash: annaHash }, projectId: project.id })
    const raw = await prisma.comment.findMany({ where: { projectId: project.id, parentId: null }, include: { replies: true, user: true } })
    const p = applySoftDelete(raw)[0] as Record<string, unknown>
    expect(p).toMatchObject({ deleted: true, content: '', authorName: null, user: null, userId: null })
    expect(p.authorKeyHash).toBeUndefined()
  })

  it('under HTTPS the cookie is __Host- prefixed and Secure', () => {
    const prev = process.env.HTTPS_ENABLED
    process.env.HTTPS_ENABLED = 'true'
    try {
      const res = setViewerCookie(NextResponse.json({}), KEY_A)
      const c = res.cookies.get('__Host-vt_viewer')!
      expect(c.secure).toBe(true)
      expect(c.path).toBe('/')
      const r = new NextRequest('https://x/', { headers: { cookie: `__Host-vt_viewer=${c.value}` } })
      expect(readViewerKey(r)).toBe(KEY_A)
    } finally {
      process.env.HTTPS_ENABLED = prev
    }
  })
})
