import { prisma } from '@/lib/db'
import { ensureGroup } from '@/lib/review'

let counter = 0
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

export async function makeProject() {
  const user = await prisma.user.create({ data: { email: `t-${uid()}@example.test`, password: 'x' } })
  const project = await prisma.project.create({
    data: { title: 'Test', slug: `test-${uid()}`, createdById: user.id },
  })
  return { user, project }
}

export async function addVersion(
  projectId: string,
  name: string,
  version: number,
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR' = 'READY'
) {
  const groupId = await ensureGroup(projectId, name)
  return prisma.video.create({
    data: {
      projectId,
      groupId,
      name,
      version,
      versionLabel: `v${version}`,
      originalFileName: `${name}.mov`,
      originalFileSize: BigInt(1000),
      originalStoragePath: `projects/${projectId}/${uid()}.mov`,
      duration: 60,
      width: 1920,
      height: 1080,
      status,
    },
  })
}

export const state = (id: string) =>
  prisma.video.findUniqueOrThrow({ where: { id }, select: { reviewState: true, approved: true } })

export const openRounds = (groupId: string) =>
  prisma.reviewRequest.findMany({ where: { groupId, closedAt: null } })
