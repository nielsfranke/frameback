import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public capability endpoint for API clients (Resolve MCP). Replaces scraping
 * `window.__STORAGE_PROVIDER__` from the /login HTML (that stays until the MCP has moved).
 *
 * SECURITY: no authentication, so it reveals only what the public login page already does
 * (storage mode) plus feature flags of the API contract — no version, hostnames or config.
 *
 * `features` only ever grows; clients check for a name before relying on it:
 *  - `video-patch-unapproved`: PATCH /api/videos/:id answers `{ approved, unapproved: [ids] }`
 */
export function GET() {
  return NextResponse.json(
    {
      app: 'frameback',
      storageProvider: process.env.STORAGE_PROVIDER === 's3' ? 's3' : 'local',
      features: ['video-patch-unapproved'],
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
