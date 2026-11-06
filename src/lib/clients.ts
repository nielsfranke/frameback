/**
 * Frameback client directory: fill it from existing projects (preview first,
 * never overwrite, safe to repeat), suggest duplicates, merge on request.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './db'
import { CLIENT_FEEDBACK_SQL } from './studio'

export class ClientError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID', message: string) { super(message) }
}

/** Exact identity of a typed company name: trim, single spaces, case-insensitive. */
export const nameKey = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('de')

const LEGAL_FORMS = /\b(ag|gmbh|mbh|sa|s\.a\.|sàrl|sarl|ltd|limited|inc|llc|kg|ug|ohg|gbr|ev|e\.v\.|co|plc|bv|nv|ab|oy|as|srl|spa)\b/g
/** Looser key for duplicate *suggestions* only (never for automatic linking). */
export const similarityKey = (s: string) =>
  nameKey(s).replace(/&/g, ' ').replace(LEGAL_FORMS, ' ').replace(/[^\p{L}\p{N}]+/gu, '')

export interface BackfillItem {
  projectId: string
  projectTitle: string
  companyName: string
  action: 'link' | 'create'
  clientId?: string
  clientName: string
}
export interface BackfillPlan {
  items: BackfillItem[]
  /** typed names matching several existing clients (case variants): left alone */
  ambiguous: Array<{ companyName: string; projectIds: string[]; candidates: string[] }>
}

/** What a backfill would do right now. Read-only. */
export async function planClientBackfill(): Promise<BackfillPlan> {
  const [projects, clients] = await Promise.all([
    prisma.project.findMany({
      where: { clientCompanyId: null, companyName: { not: null } },
      select: { id: true, title: true, companyName: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.clientCompany.findMany({ select: { id: true, name: true } }),
  ])
  const existing = new Map<string, Array<{ id: string; name: string }>>()
  for (const c of clients) existing.set(nameKey(c.name), [...(existing.get(nameKey(c.name)) ?? []), c])

  const byKey = new Map<string, Array<{ id: string; title: string; name: string }>>()
  for (const p of projects) {
    const name = p.companyName!.replace(/\s+/g, ' ').trim()
    if (!name) continue
    byKey.set(nameKey(name), [...(byKey.get(nameKey(name)) ?? []), { id: p.id, title: p.title, name }])
  }

  const plan: BackfillPlan = { items: [], ambiguous: [] }
  for (const [key, list] of byKey) {
    const matches = existing.get(key) ?? []
    if (matches.length > 1) {
      plan.ambiguous.push({ companyName: list[0].name, projectIds: list.map((p) => p.id), candidates: matches.map((m) => m.name) })
      continue
    }
    // new client: the most common spelling wins, earliest on a tie
    const spelling = matches[0]?.name ?? [...list.reduce((m, p) => m.set(p.name, (m.get(p.name) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])[0][0]
    for (const p of list) {
      plan.items.push(matches[0]
        ? { projectId: p.id, projectTitle: p.title, companyName: p.name, action: 'link', clientId: matches[0].id, clientName: matches[0].name }
        : { projectId: p.id, projectTitle: p.title, companyName: p.name, action: 'create', clientName: spelling })
    }
  }
  return plan
}

/**
 * Apply the backfill. Only projects listed in `onlyProjectIds` (the previewed set) are
 * touched, and only while they still have no client – a second run changes nothing.
 */
export async function applyClientBackfill(onlyProjectIds?: string[]) {
  const plan = await planClientBackfill()
  const allowed = onlyProjectIds ? new Set(onlyProjectIds) : null
  const items = plan.items.filter((i) => !allowed || allowed.has(i.projectId))
  const log: Array<BackfillItem & { result: 'linked' | 'skipped' }> = []
  let created = 0
  await prisma.$transaction(async (tx) => {
    const ids = new Map<string, string>() // nameKey -> client id (created in this run)
    for (const it of items) {
      let clientId = it.clientId
      if (!clientId) {
        const key = nameKey(it.clientName)
        clientId = ids.get(key)
        if (!clientId) {
          // unique name: a concurrent run that created it first wins, we reuse it
          const c = await tx.clientCompany.upsert({ where: { name: it.clientName }, update: {}, create: { name: it.clientName }, select: { id: true, createdAt: true } })
          clientId = c.id
          ids.set(key, clientId)
          created++
        }
      }
      const r = await tx.project.updateMany({ where: { id: it.projectId, clientCompanyId: null }, data: { clientCompanyId: clientId } })
      log.push({ ...it, clientId, result: r.count ? 'linked' : 'skipped' })
    }
  }, { timeout: 60_000 })
  return { linked: log.filter((l) => l.result === 'linked').length, skipped: log.filter((l) => l.result === 'skipped').length, clientsCreated: created, ambiguous: plan.ambiguous, log }
}

const pairKey = (a: string, b: string) => (a < b ? [a, b] as const : [b, a] as const)

/** Pairs of clients that look like the same company and were not decided yet. */
export async function duplicateSuggestions() {
  const [clients, decisions] = await Promise.all([
    prisma.clientCompany.findMany({ select: { id: true, name: true, _count: { select: { projects: true } } } }),
    prisma.clientMergeDecision.findMany({ select: { aId: true, bId: true } }),
  ])
  const decided = new Set(decisions.map((d) => `${d.aId}|${d.bId}`))
  const groups = new Map<string, typeof clients>()
  for (const c of clients) {
    const k = similarityKey(c.name)
    if (k.length < 3) continue
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  const out: Array<{ a: { id: string; name: string; projects: number }; b: { id: string; name: string; projects: number } }> = []
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [x, y] = pairKey(list[i].id, list[j].id)
      if (decided.has(`${x}|${y}`)) continue
      // suggest merging the smaller into the bigger one
      const [small, big] = list[i]._count.projects <= list[j]._count.projects ? [list[i], list[j]] : [list[j], list[i]]
      out.push({ a: { id: small.id, name: small.name, projects: small._count.projects }, b: { id: big.id, name: big.name, projects: big._count.projects } })
    }
  }
  return out
}

export async function keepSeparate(aId: string, bId: string) {
  const [x, y] = pairKey(aId, bId)
  await prisma.clientMergeDecision.upsert({ where: { aId_bId: { aId: x, bId: y } }, update: { decision: 'KEEP_SEPARATE', decidedAt: new Date() }, create: { aId: x, bId: y, decision: 'KEEP_SEPARATE' } })
}

/** Merge `sourceId` into `targetId`: projects and contacts move, duplicate e-mails collapse, source is removed. */
export async function mergeClients(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new ClientError('INVALID', 'Cannot merge a client into itself')
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ClientCompany" WHERE id IN (${sourceId}, ${targetId}) ORDER BY id FOR UPDATE`
    if (locked.length !== 2) throw new ClientError('NOT_FOUND', 'Client not found')
    const projects = await tx.project.updateMany({ where: { clientCompanyId: sourceId }, data: { clientCompanyId: targetId } })
    const targetMails = new Set(
      (await tx.clientContact.findMany({ where: { companyId: targetId, email: { not: null } }, select: { email: true } }))
        .map((c) => c.email!.trim().toLowerCase()),
    )
    let moved = 0
    let collapsed = 0
    for (const c of await tx.clientContact.findMany({ where: { companyId: sourceId } })) {
      const mail = c.email?.trim().toLowerCase()
      if (mail && targetMails.has(mail)) { await tx.clientContact.delete({ where: { id: c.id } }); collapsed++; continue }
      await tx.clientContact.update({ where: { id: c.id }, data: { companyId: targetId } })
      if (mail) targetMails.add(mail)
      moved++
    }
    await tx.clientCompany.delete({ where: { id: sourceId } })
    const [x, y] = pairKey(sourceId, targetId)
    await tx.clientMergeDecision.upsert({ where: { aId_bId: { aId: x, bId: y } }, update: { decision: 'MERGED', decidedAt: new Date() }, create: { aId: x, bId: y, decision: 'MERGED' } })
    return { projects: projects.count, contactsMoved: moved, contactsCollapsed: collapsed }
  })
}

/** Directory rows: active projects, projects with unread feedback (for this user), contacts, last activity. */
export async function clientList(userId: string) {
  const clients = await prisma.clientCompany.findMany({
    select: {
      id: true, name: true,
      _count: { select: { contacts: true } },
      projects: { select: { id: true, status: true, updatedAt: true } },
    },
    orderBy: { name: 'asc' },
  })
  const projectIds = clients.flatMap((c) => c.projects.map((p) => p.id))
  const unread = projectIds.length
    ? await prisma.$queryRaw<Array<{ projectId: string }>>`
        SELECT DISTINCT c."projectId" FROM "Comment" c JOIN "User" u ON u.id = ${userId}
         WHERE c."projectId" IN (${Prisma.join(projectIds)}) AND ${CLIENT_FEEDBACK_SQL}
           AND c."createdAt" > u."feedbackSeenBaseline"
           AND NOT EXISTS (SELECT 1 FROM "StudioCommentSeen" s WHERE s."userId" = ${userId} AND s."commentId" = c.id)`
    : []
  const withUnread = new Set(unread.map((u) => u.projectId))
  return clients.map((c) => ({
    id: c.id,
    name: c.name,
    activeProjects: c.projects.filter((p) => p.status !== 'ARCHIVED').length,
    unreadProjects: c.projects.filter((p) => p.status !== 'ARCHIVED' && withUnread.has(p.id)).length,
    contacts: c._count.contacts,
    lastActivityAt: c.projects.reduce<string | null>((m, p) => (!m || p.updatedAt.toISOString() > m ? p.updatedAt.toISOString() : m), null),
  }))
}

/** Client page: contacts, plus project recipients not yet saved as contacts (with origin). */
export async function clientDetail(id: string) {
  const client = await prisma.clientCompany.findUnique({
    where: { id },
    select: {
      id: true, name: true,
      contacts: { select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } },
      projects: { select: { id: true, title: true, recipients: { select: { name: true, email: true } } } },
    },
  })
  if (!client) throw new ClientError('NOT_FOUND', 'Client not found')
  const known = new Set(client.contacts.map((c) => c.email?.trim().toLowerCase()).filter(Boolean))
  const recipients = new Map<string, { name: string | null; email: string; projects: string[] }>()
  for (const p of client.projects) for (const r of p.recipients) {
    const mail = r.email?.trim().toLowerCase()
    if (!mail || known.has(mail)) continue
    const cur = recipients.get(mail) ?? { name: r.name, email: r.email!.trim(), projects: [] }
    if (!cur.projects.includes(p.title)) cur.projects.push(p.title)
    if (!cur.name && r.name) cur.name = r.name
    recipients.set(mail, cur)
  }
  // origin for saved contacts too ("Empfänger in …")
  const origin = new Map<string, string[]>()
  for (const p of client.projects) for (const r of p.recipients) {
    const mail = r.email?.trim().toLowerCase()
    if (mail && known.has(mail)) origin.set(mail, [...new Set([...(origin.get(mail) ?? []), p.title])])
  }
  return {
    id: client.id,
    name: client.name,
    contacts: client.contacts.map((c) => ({ ...c, projects: c.email ? origin.get(c.email.trim().toLowerCase()) ?? [] : [] })),
    recipientSuggestions: [...recipients.values()],
  }
}
