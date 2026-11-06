// Characterization tests for timecode handling. Comment positions feed the
// Resolve MCP (frame-accurate markers), so this behaviour is part of the contract.
import { describe, expect, it } from 'vitest'
import { secondsToTimecode, timecodeToSeconds, isValidTimecode } from '@/lib/timecode'

describe('timecode', () => {
  it('formats HH:MM:SS:FF at 24 fps (schema example)', () => {
    expect(secondsToTimecode(32 + 15 / 24, 24)).toBe('00:00:32:15')
  })

  it.each([24, 25, 30, 50])('round-trips whole frames at %i fps', (fps) => {
    for (const frame of [0, 1, fps - 1, fps, 10 * fps + 3, 3600 * fps + 7]) {
      const seconds = frame / fps
      const tc = secondsToTimecode(seconds, fps)
      expect(isValidTimecode(tc)).toBe(true)
      expect(Math.round(timecodeToSeconds(tc, fps) * fps)).toBe(frame)
    }
  })
})
