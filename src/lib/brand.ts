import { prisma } from '@/lib/db'
import { LOGO_BUBBLE_PATH, LOGO_CORNERS_PATH } from '@/lib/app-brand'

type AccentKey =
  | 'blue'
  | 'purple'
  | 'green'
  | 'orange'
  | 'red'
  | 'pink'
  | 'teal'
  | 'amber'
  | 'stone'
  | 'gold'

const accentPalette: Record<AccentKey, string> = {
  blue: 'hsl(211 100% 50%)',
  purple: 'hsl(262 83% 58%)',
  green: 'hsl(145 63% 42%)',
  orange: 'hsl(25 95% 53%)',
  red: 'hsl(0 84% 60%)',
  pink: 'hsl(330 81% 60%)',
  teal: 'hsl(173 80% 40%)',
  amber: 'hsl(38 92% 50%)',
  stone: 'hsl(30 12% 50%)',
  gold: 'hsl(37 56% 65%)',
}

export async function getAccentColor(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { accentColor: true },
    })
    const accentKey = (settings?.accentColor as AccentKey | undefined) || 'blue'
    return accentPalette[accentKey] || accentPalette.blue
  } catch {
    return accentPalette.blue
  }
}

export function buildLogoSvg(accentColor: string, size: number): string {
  // Frameback logo (concept 1): frame corners + speech bubble on a rounded tile
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <style>
    :root { --logo-bg: #0f1012; --logo-fg: #ffffff; }
    @media (prefers-color-scheme: dark) { :root { --logo-bg: #f5f7fb; --logo-fg: #0f1012; } }
  </style>
  <rect width="64" height="64" rx="14" fill="var(--logo-bg)"/>
  <g transform="translate(6.4 6.4) scale(0.8)">
    <path d="${LOGO_CORNERS_PATH}" fill="none" stroke="var(--logo-fg)" stroke-width="6" stroke-linecap="square"/>
    <path d="${LOGO_BUBBLE_PATH}" fill="${accentColor}"/>
  </g>
</svg>`
}
