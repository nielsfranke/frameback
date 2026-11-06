import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prisma } from '@/lib/db'
import { addVersion, makeProject } from './helpers'

// storage reads STORAGE_ROOT at import time: set it before loading the module under test
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-storage-'))
process.env.STORAGE_ROOT = root
let thumbnailFromFrame: typeof import('@/lib/frame-thumbnail').thumbnailFromFrame
let FrameError: typeof import('@/lib/frame-thumbnail').FrameError

beforeAll(async () => {
  ;({ thumbnailFromFrame, FrameError } = await import('@/lib/frame-thumbnail'))
})
afterAll(async () => { fs.rmSync(root, { recursive: true, force: true }); await prisma.$disconnect() })

async function videoWithFile() {
  const { project, user } = await makeProject()
  const v = await addVersion(project.id, 'Film', 1)
  const rel = `projects/${project.id}/videos/${v.id}/original.mp4`
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
  // 3 s test video, 640x360
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-pix_fmt', 'yuv420p', '-y', path.join(root, rel)])
  await prisma.video.update({ where: { id: v.id }, data: { originalStoragePath: rel, duration: 3 } })
  return { user, v }
}

describe('frame as thumbnail', () => {
  it('grabs the frame, stores it as an image asset and makes it the thumbnail', async () => {
    const { user, v } = await videoWithFile()
    const r = await thumbnailFromFrame({ videoId: v.id, seconds: 1.5, userId: user.id, userName: 'Studio' })
    expect(r.seconds).toBe(1.5)
    const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: r.assetId } })
    expect(asset).toMatchObject({ videoId: v.id, fileType: 'image/jpeg', category: 'image' })
    expect(asset.uploadCompletedAt).not.toBeNull()
    expect((await prisma.video.findUniqueOrThrow({ where: { id: v.id } })).thumbnailPath).toBe(asset.storagePath)
    const file = fs.readFileSync(path.join(root, asset.storagePath))
    expect(file.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])) // JPEG
    expect(Number(asset.fileSize)).toBe(file.length)
  })

  it('clamps a position past the end into the video', async () => {
    const { user, v } = await videoWithFile()
    const r = await thumbnailFromFrame({ videoId: v.id, seconds: 99, userId: user.id, userName: 'Studio' })
    expect(r.seconds).toBeLessThan(3)
  })

  it('refuses versions that are not processed, and unknown videos', async () => {
    const { project, user } = await makeProject()
    const p = await addVersion(project.id, 'Neu', 1, 'PROCESSING')
    await expect(thumbnailFromFrame({ videoId: p.id, seconds: 1, userId: user.id, userName: 'S' })).rejects.toMatchObject({ code: 'NOT_READY' })
    await expect(thumbnailFromFrame({ videoId: 'nope', seconds: 1, userId: user.id, userName: 'S' })).rejects.toBeInstanceOf(FrameError)
  })
})
