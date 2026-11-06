import { beforeAll, describe, expect, it } from 'vitest'
import { readReplyUnsubscribeToken, replyMailWindow, replyUnsubscribeToken } from '@/lib/reply-notifications'

beforeAll(() => { process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-reply-tokens' })

describe('reply notifications (no spam)', () => {
  it('throttle window follows the project client schedule', () => {
    expect(replyMailWindow('IMMEDIATE')).toBe(900)
    expect(replyMailWindow('HOURLY')).toBe(3600)
    expect(replyMailWindow('DAILY')).toBe(86400)
    expect(replyMailWindow('WEEKLY')).toBe(604800)
    expect(replyMailWindow(null)).toBe(3600)
  })

  it('unsubscribe tokens are signed, per project and email', () => {
    const t = replyUnsubscribeToken('proj1', 'Anna@Firma.ch')
    expect(readReplyUnsubscribeToken(t)).toEqual({ projectId: 'proj1', email: 'anna@firma.ch' })
    const [payload] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ p: 'proj2', e: 'anna@firma.ch' })).toString('base64url')
    expect(readReplyUnsubscribeToken(`${forged}.${t.split('.')[1]}`)).toBeNull()
    expect(readReplyUnsubscribeToken(`${payload}.wrong`)).toBeNull()
    expect(readReplyUnsubscribeToken('garbage')).toBeNull()
  })
})
