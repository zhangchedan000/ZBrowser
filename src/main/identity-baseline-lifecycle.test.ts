import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { identityRelevantProfileChanged } from './identity-baseline-lifecycle'

function profile(): BrowserProfile {
  const draft = defaultProfileDraft()
  return {
    ...draft,
    id: 'profile-1',
    serialNumber: 1,
    favorite: false,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    status: 'closed'
  }
}

describe('identity baseline lifecycle change detection', () => {
  it('ignores metadata-only profile edits', () => {
    const before = profile()
    const after = { ...before, name: 'Renamed', note: 'metadata only' }
    expect(identityRelevantProfileChanged(before, after)).toBe(false)
  })

  it('detects fingerprint, kernel and proxy route changes', () => {
    const before = profile()
    expect(identityRelevantProfileChanged(before, {
      ...before,
      fingerprint: { ...before.fingerprint, language: 'ja-JP' }
    })).toBe(true)
    expect(identityRelevantProfileChanged(before, {
      ...before,
      kernelVersion: '145.0.0.1'
    })).toBe(true)
    expect(identityRelevantProfileChanged(before, {
      ...before,
      proxy: { ...before.proxy, protocol: 'http', host: '127.0.0.1', port: 8080 }
    })).toBe(true)
  })

  it('does not treat a proxy password-only change as an identity route change', () => {
    const before = profile()
    const after = { ...before, proxy: { ...before.proxy, password: 'rotated-secret' } }
    expect(identityRelevantProfileChanged(before, after)).toBe(false)
  })
})
