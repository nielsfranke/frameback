'use client'

import { cn } from '@/lib/utils'
import { APP_NAME, LOGO_BUBBLE_PATH, LOGO_CORNERS_PATH } from '@/lib/app-brand'

type LogoMarkProps = {
  size?: number
  accent?: string
  className?: string
  ariaHidden?: boolean
}

/**
 * Reusable Frameback logomark (concept 1). Accent fill uses the global accent color by default.
 */
function LogoMark({
  size = 64,
  accent = 'hsl(var(--primary, 211 100% 50%))',
  className,
  ariaHidden = false,
}: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={ariaHidden ? 'presentation' : 'img'}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : `${APP_NAME} logo`}
      className={cn('shrink-0', className)}
    >
      <rect width="64" height="64" rx="14" fill="var(--logo-bg)" />
      {/* Frameback logo (concept 1): frame corners + speech bubble */}
      <g transform="translate(6.4 6.4) scale(0.8)">
        <path d={LOGO_CORNERS_PATH} fill="none" stroke="var(--logo-wedge)" strokeWidth={6} strokeLinecap="square" />
        <path d={LOGO_BUBBLE_PATH} fill={accent} />
      </g>
    </svg>
  )
}

export default LogoMark
