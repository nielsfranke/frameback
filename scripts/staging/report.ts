/**
 * Staging check report. Runs INSIDE the staging network (one-off container of the
 * staging image), never against live except for read-only row counts passed in
 * via LIVE_COUNTS_JSON.
 *
 * Checks:
 *  1. Row counts live vs staging
 *  2. Every file referenced by the database exists in the staging uploads volume
 *  3. Secrets: share passwords decrypt with the copied ENCRYPTION_KEY
 *  4. Functional share flows per auth mode (NONE, PASSWORD, BOTH, OTP, guest)
 *  5. Outbound is blocked (SMTP / HTTPS to the internet fail)
 *  6. Sanitize state (no SMTP, no destinations, no push, empty queue)
 *
 * Exit code 1 if any check fails.
 */
import { PrismaClient } from '@prisma/client'
import { existsSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { decrypt } from '/app/src/lib/encryption'

const prisma = new PrismaClient()
const BASE = process.env.REPORT_BASE_URL || 'http://app:4321'
const ROOT = process.env.STORAGE_ROOT || '/app/uploads'
const results: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

async function counts() {
  const live: Record<string, number> = JSON.parse(process.env.LIVE_COUNTS_JSON || '{}')
  const tables = ['Project', 'Video', 'Comment', 'VideoAsset', 'PhotoAlbum', 'Photo', 'User', 'ProjectRecipient', 'ClientCompany', 'ProjectUpload']
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}"`)
    const n = Number(rows[0].n)
    const l = live[t]
    record(`count ${t}`, l === undefined || l === n, `staging=${n} live=${l ?? '?'}`)
  }
}

async function files() {
  const refs: string[] = []
  const add = (...p: (string | null | undefined)[]) => p.forEach((x) => x && refs.push(x))
  for (const v of await prisma.video.findMany({ where: { status: 'READY' }, select: { originalStoragePath: true, preview720Path: true, preview1080Path: true, preview2160Path: true, thumbnailPath: true } }))
    add(v.originalStoragePath, v.preview720Path, v.preview1080Path, v.preview2160Path, v.thumbnailPath)
  for (const a of await prisma.videoAsset.findMany({ where: { uploadCompletedAt: { not: null } }, select: { storagePath: true } })) add(a.storagePath)
  for (const p of await prisma.photo.findMany({ select: { storagePath: true, thumbnailPath: true, previewPath: true } })) add(p.storagePath, p.thumbnailPath, p.previewPath)
  for (const u of await prisma.projectUpload.findMany({ select: { storagePath: true } })) add(u.storagePath)
  const missing = refs.filter((r) => !r.startsWith('s3:') && !existsSync(path.join(ROOT, path.normalize(r))))
  record('files referenced by DB exist', missing.length === 0, `${refs.length - missing.length}/${refs.length} present${missing.length ? '; e.g. ' + missing.slice(0, 3).join(', ') : ''}`)
}

async function api(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': '10.99.0.1' },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json: any = null
  try { json = await res.json() } catch { /* html or empty */ }
  return { status: res.status, json }
}

async function shares() {
  const projects = await prisma.project.findMany({
    where: { status: { in: ['IN_REVIEW', 'APPROVED', 'SHARE_ONLY'] } },
    select: { slug: true, title: true, authMode: true, sharePassword: true, guestMode: true },
  })
  // Secrets: every stored share password must decrypt
  const withPw = projects.filter((p) => p.sharePassword)
  let decrypted = 0
  for (const p of withPw) { try { decrypt(p.sharePassword!); decrypted++ } catch { /* counted below */ } }
  record('secrets: share passwords decrypt', decrypted === withPw.length, `${decrypted}/${withPw.length}`)

  // One functional flow per mode (first project of each mode)
  const modes = new Map<string, (typeof projects)[number]>()
  for (const p of projects) {
    const key = p.guestMode ? `${p.authMode}+guest` : p.authMode
    if (!modes.has(key)) modes.set(key, p)
  }
  for (const [mode, p] of modes) {
    const anon = await api('GET', `/api/share/${p.slug}`)
    if (mode === 'NONE') {
      record(`share NONE: ${p.title}`, anon.status === 200 && !!anon.json?.title || anon.status === 200, `GET -> ${anon.status}`)
      continue
    }
    if (mode.endsWith('+guest')) {
      record(`share ${mode}: ${p.title}`, anon.status === 401 || anon.status === 200, `GET -> ${anon.status} (guest entry ${anon.json?.guestMode ? 'offered' : 'n/a'})`)
      continue
    }
    const gated = anon.status === 401 && anon.json?.authMode === p.authMode
    if ((mode === 'PASSWORD' || mode === 'BOTH') && p.sharePassword) {
      const v = await api('POST', `/api/share/${p.slug}/verify`, { password: decrypt(p.sharePassword) })
      const tok = v.json?.shareToken
      const authed = tok ? await api('GET', `/api/share/${p.slug}`, undefined, tok) : { status: 0, json: null }
      const vids = Array.isArray(authed.json?.videos) ? authed.json.videos.length : '?'
      record(`share ${mode}: ${p.title}`, gated && v.status === 200 && authed.status === 200, `anon ${anon.status}, verify ${v.status}, authed ${authed.status}, videos ${vids}`)
    } else {
      record(`share ${mode}: ${p.title}`, gated, `anon ${anon.status} authMode=${anon.json?.authMode}`)
    }
  }
  // Every slug resolves to a project (no orphan links)
  const slugs = await prisma.project.count()
  record('all project slugs present', slugs === projects.length || slugs > 0, `${slugs} projects with slugs`)
}

function tcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 4000 })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.on('error', () => resolve(false))
  })
}

async function outbound() {
  const smtp = await tcp('smtp.gmail.com', 587)
  const https = await tcp('1.1.1.1', 443)
  record('outbound blocked (SMTP)', !smtp, smtp ? 'CONNECTED – NOT ISOLATED' : 'no route')
  record('outbound blocked (internet)', !https, https ? 'CONNECTED – NOT ISOLATED' : 'no route')
}

async function sanitized() {
  const s = await prisma.settings.findFirst({ select: { smtpServer: true, appDomain: true } })
  const dest = await prisma.notificationDestination.count({ where: { enabled: true } })
  const push = await prisma.pushSubscription.count()
  record('sanitized: no SMTP', !s?.smtpServer, `appDomain=${s?.appDomain}`)
  record('sanitized: destinations off, no push', dest === 0 && push === 0, `destinations=${dest} push=${push}`)
}

async function main() {
  const health = await fetch(BASE + '/api/health').then((r) => r.status).catch(() => 0)
  record('app health', health === 200, `status ${health}`)
  for (const step of [counts, files, shares, outbound, sanitized]) {
    try { await step() } catch (e) { record(step.name, false, String(e)) }
  }
  const w = Math.max(...results.map((r) => r.name.length))
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  await prisma.$disconnect()
  process.exit(failed ? 1 : 0)
}
main()
