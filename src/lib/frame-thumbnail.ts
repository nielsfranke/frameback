/**
 * Frameback: "Aktuelles Bild als Thumbnail" – grab the exact frame at the player
 * position from the ORIGINAL file, store it as an image asset of that version
 * (downloadable like other images) and use it as the version's thumbnail.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prisma } from './db'
import { deleteFile, getFilePath, isS3Mode, uploadFile } from './storage'
import { s3GetPresignedDownloadUrl } from './s3-storage'

export class FrameError extends Error {
  constructor(public code: 'NOT_FOUND' | 'NOT_READY' | 'FAILED', message: string) { super(message) }
}

const mmss = (s: number) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`

// One frame grab at a time per server process: decoding originals is heavy, the web
// server must stay responsive. Further requests wait their turn (bounded by the rate limit).
let queue: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => {})
  return run
}

function runFfmpeg(args: string[], timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')) }, timeoutMs)
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}: ${err}`)) })
  })
}

export function thumbnailFromFrame(input: { videoId: string; seconds: number; userId: string; userName: string }) {
  return oneAtATime(() => grab(input))
}

async function grab(input: { videoId: string; seconds: number; userId: string; userName: string }) {
  const video = await prisma.video.findUnique({
    where: { id: input.videoId },
    select: { id: true, projectId: true, name: true, version: true, status: true, duration: true, originalStoragePath: true, originalFileName: true },
  })
  if (!video) throw new FrameError('NOT_FOUND', 'Video not found')
  if (video.status !== 'READY') throw new FrameError('NOT_READY', 'Video is not processed yet')

  // stay inside the video: the very last frame may not decode at duration exactly
  const max = Math.max(0, (video.duration || 0) - 0.05)
  const at = Math.min(Math.max(0, Number.isFinite(input.seconds) ? input.seconds : 0), max)

  const source = isS3Mode()
    ? await s3GetPresignedDownloadUrl(video.originalStoragePath, 600)
    : getFilePath(video.originalStoragePath)
  const tmp = path.join(os.tmpdir(), `fb-frame-${video.id}-${Date.now()}.jpg`)
  let uploaded: string | null = null // stored but not yet recorded: removed again on failure
  try {
    // -ss before -i seeks fast and frame-accurately in current ffmpeg; full resolution up to 4K
    await runFfmpeg(['-v', 'error', '-threads', '2', '-ss', at.toFixed(3), '-i', source, '-frames:v', '1', '-vf', "scale='min(3840,iw)':-2", '-q:v', '2', '-y', tmp])
    const size = (await fs.promises.stat(tmp)).size
    if (!size) throw new Error('empty frame')
    const stamp = Date.now()
    const storagePath = `projects/${video.projectId}/videos/assets/${video.id}/frame-${stamp}-${mmss(at)}.jpg`
    await uploadFile(storagePath, fs.createReadStream(tmp), size, 'image/jpeg')
    uploaded = storagePath
    const fileName = `${video.name} v${video.version} – ${mmss(at)}.jpg`.replace(/[\\/:*?"<>|]+/g, '-')
    const asset = await prisma.$transaction(async (tx) => {
      const a = await tx.videoAsset.create({
        data: {
          videoId: video.id,
          fileName,
          fileSize: BigInt(size),
          fileType: 'image/jpeg',
          storagePath,
          category: 'image',
          uploadedBy: input.userId,
          uploadedByName: input.userName,
          uploadCompletedAt: new Date(),
        },
        select: { id: true, fileName: true },
      })
      await tx.video.update({ where: { id: video.id }, data: { thumbnailPath: storagePath } })
      return a
    })
    uploaded = null
    return { assetId: asset.id, fileName: asset.fileName, seconds: at }
  } catch (e) {
    if (e instanceof FrameError) throw e
    throw new FrameError('FAILED', e instanceof Error ? e.message : 'Frame grab failed')
  } finally {
    await fs.promises.unlink(tmp).catch(() => {})
    if (uploaded) await deleteFile(uploaded).catch(() => {})
  }
}
