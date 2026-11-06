import { beforeAll, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { rejectCrossOrigin } from '@/lib/same-origin'

const req = (headers: Record<string, string>) =>
  new NextRequest('http://staging-host:4325/api/comments/x', { method: 'DELETE', headers: { host: 'staging-host:4325', ...headers } })

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'http://staging-host:4325'
  process.env.ALLOWED_ORIGINS = 'https://staging-host:4326'
})

describe('rejectCrossOrigin (CSRF)', () => {
  it('allows same-origin browser writes', () => {
    expect(rejectCrossOrigin(req({ origin: 'http://staging-host:4325' }))).toBeNull()
  })
  it('allows configured extra origins, ignores forged forwarded headers', () => {
    expect(rejectCrossOrigin(req({ origin: 'https://staging-host:4326' }))).toBeNull()
    expect(rejectCrossOrigin(req({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }))?.status).toBe(403)
  })
  it('refuses foreign origins', () => {
    expect(rejectCrossOrigin(req({ origin: 'https://evil.example' }))?.status).toBe(403)
  })
  it('refuses writes without Origin unless a bearer token is sent (MCP, scripts)', () => {
    expect(rejectCrossOrigin(req({}))?.status).toBe(403)
    expect(rejectCrossOrigin(req({ authorization: 'Bearer abc' }))).toBeNull()
  })
})
