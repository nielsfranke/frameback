/**
 * Fill the client directory from the free-text company names of existing projects.
 *
 *   npx tsx scripts/clients/backfill.ts --dry-run          # show what would happen
 *   npx tsx scripts/clients/backfill.ts --log out.json     # apply, write a log
 *
 * Only projects without a client are touched, existing links are never changed,
 * names matching several existing clients are skipped, and a second run changes nothing.
 * Run it on a copy of production (staging) first and read the log.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../../src/lib/db'
import { applyClientBackfill, planClientBackfill } from '../../src/lib/clients'

async function main() {
  const dry = process.argv.includes('--dry-run')
  const logIdx = process.argv.indexOf('--log')
  const logFile = logIdx > 0 ? process.argv[logIdx + 1] : null
  const plan = await planClientBackfill()
  const creates = new Set(plan.items.filter((i) => i.action === 'create').map((i) => i.clientName))
  console.log(`Projects to link: ${plan.items.length} (to existing clients: ${plan.items.filter((i) => i.action === 'link').length}, new clients: ${creates.size})`)
  for (const i of plan.items) console.log(`  ${i.action === 'create' ? 'NEW ' : 'LINK'} ${i.clientName}  <-  "${i.projectTitle}" (${i.companyName})`)
  if (plan.ambiguous.length) {
    console.log(`Skipped (name matches several clients): ${plan.ambiguous.length}`)
    for (const a of plan.ambiguous) console.log(`  ${a.companyName}: ${a.candidates.join(' | ')}`)
  }
  if (dry) { console.log('Dry run – nothing changed.'); return }
  const r = await applyClientBackfill(plan.items)
  console.log(`Done: ${r.linked} linked, ${r.clientsCreated} clients created, ${r.skipped} skipped (changed meanwhile).`)
  if (logFile) { writeFileSync(logFile, JSON.stringify(r, null, 2)); console.log(`Log: ${logFile}`) }
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
