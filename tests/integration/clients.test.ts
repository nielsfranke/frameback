import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/db'
import { applyClientBackfill, ClientError, duplicateSuggestions, keepSeparate, mergeClients, nameKey, planClientBackfill, similarityKey } from '@/lib/clients'
import { makeProject } from './helpers'

afterAll(() => prisma.$disconnect())

// the backfill looks at all projects: keep this file's world small and own it
const tag = `T${Date.now().toString(36)}`
const name = (s: string) => `${s} ${tag}`

async function projectFor(company: string | null, clientCompanyId?: string) {
  const { project } = await makeProject()
  return prisma.project.update({ where: { id: project.id }, data: { companyName: company, clientCompanyId: clientCompanyId ?? null } })
}
const mine = <T extends { projectId: string }>(items: T[], ids: string[]) => items.filter((i) => ids.includes(i.projectId))

describe('keys', () => {
  it('nameKey is exact up to spaces and case; similarityKey also ignores legal forms and punctuation', () => {
    expect(nameKey('  Nordwind   AG ')).toBe(nameKey('nordwind ag'))
    expect(nameKey('Nordwind AG')).not.toBe(nameKey('Nordwind'))
    expect(similarityKey('Nordwind AG')).toBe(similarityKey('Nordwind'))
    expect(similarityKey('Müller & Co. GmbH')).toBe(similarityKey('Müller'))
  })
})

describe('backfill', () => {
  it('links to an existing client, creates missing ones once, never overwrites, and is idempotent', async () => {
    const existing = await prisma.clientCompany.create({ data: { name: name('Contoso AG') } })
    const other = await prisma.clientCompany.create({ data: { name: name('Fabrikam') } })
    const a = await projectFor(`  ${name('contoso ag')} `)
    const b = await projectFor(name('Neukunde GmbH'))
    const c = await projectFor(name('Neukunde GmbH'))
    const d = await projectFor(name('Contoso AG'), other.id) // already linked elsewhere: untouched
    const e = await projectFor('   ')
    const ids = [a.id, b.id, c.id, d.id, e.id]

    const plan = mine((await planClientBackfill()).items, ids)
    expect(plan.find((i) => i.projectId === a.id)).toMatchObject({ action: 'link', clientId: existing.id })
    expect(plan.filter((i) => i.action === 'create').map((i) => i.projectId).sort()).toEqual([b.id, c.id].sort())
    expect(plan.some((i) => i.projectId === d.id || i.projectId === e.id)).toBe(false)

    const r = await applyClientBackfill(ids)
    expect(r.linked).toBe(3)
    const created = await prisma.clientCompany.findMany({ where: { name: name('Neukunde GmbH') } })
    expect(created).toHaveLength(1)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: b.id } })).clientCompanyId).toBe(created[0].id)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: d.id } })).clientCompanyId).toBe(other.id)

    const again = await applyClientBackfill(ids)
    expect(again.linked).toBe(0)
    expect(await prisma.clientCompany.count({ where: { name: name('Neukunde GmbH') } })).toBe(1)
  })

  it('only touches the previewed projects', async () => {
    const a = await projectFor(name('Vorschau'))
    const b = await projectFor(name('Vorschau'))
    await applyClientBackfill([a.id])
    expect((await prisma.project.findUniqueOrThrow({ where: { id: b.id } })).clientCompanyId).toBeNull()
  })

  it('leaves names alone that match several existing clients', async () => {
    await prisma.clientCompany.create({ data: { name: name('Doppel AG') } })
    await prisma.clientCompany.create({ data: { name: name('DOPPEL AG') } })
    const p = await projectFor(name('doppel ag'))
    const plan = await planClientBackfill()
    expect(plan.items.some((i) => i.projectId === p.id)).toBe(false)
    expect(plan.ambiguous.some((x) => x.projectIds.includes(p.id))).toBe(true)
  })
})

describe('duplicates and merge', () => {
  it('suggests look-alikes, remembers "keep separate", merges projects and contacts', async () => {
    const big = await prisma.clientCompany.create({ data: { name: name('Nordwind AG') } })
    const small = await prisma.clientCompany.create({ data: { name: name('Nordwind') } })
    await projectFor(null, big.id); await projectFor(null, big.id)
    const p = await projectFor(null, small.id)
    await prisma.clientContact.create({ data: { companyId: big.id, name: 'Alex', email: 'alex@nordwind.example' } })
    await prisma.clientContact.create({ data: { companyId: small.id, name: 'Alex B.', email: 'ALEX@nordwind.example' } })
    await prisma.clientContact.create({ data: { companyId: small.id, name: 'Kim', email: 'kim@nordwind.example' } })

    const s = (await duplicateSuggestions()).find((x) => [x.a.id, x.b.id].includes(small.id))!
    expect(s).toMatchObject({ a: { id: small.id }, b: { id: big.id } })

    const r = await mergeClients(small.id, big.id)
    expect(r).toEqual({ projects: 1, contactsMoved: 1, contactsCollapsed: 1 })
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).clientCompanyId).toBe(big.id)
    expect(await prisma.clientCompany.findUnique({ where: { id: small.id } })).toBeNull()
    expect(await prisma.clientContact.count({ where: { companyId: big.id } })).toBe(2)
  })

  it('"keep separate" is remembered', async () => {
    const a = await prisma.clientCompany.create({ data: { name: name('Seetal Werke') } })
    const b = await prisma.clientCompany.create({ data: { name: name('Seetal Werke AG') } })
    expect((await duplicateSuggestions()).some((x) => [x.a.id, x.b.id].includes(a.id))).toBe(true)
    await keepSeparate(b.id, a.id)
    expect((await duplicateSuggestions()).some((x) => [x.a.id, x.b.id].includes(a.id))).toBe(false)
  })

  it('refuses self-merge and unknown clients', async () => {
    const a = await prisma.clientCompany.create({ data: { name: name('Solo') } })
    await expect(mergeClients(a.id, a.id)).rejects.toBeInstanceOf(ClientError)
    await expect(mergeClients(a.id, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
