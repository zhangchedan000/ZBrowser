import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { parseProfileConfig, serializeProfileConfig } from './profile-transfer'

describe('profile config transfer', () => {
  it('preserves an explicit kernel family with the pinned version', () => {
    const draft = defaultProfileDraft()
    draft.kernelVersion = '144.0.7559.132'
    draft.kernelFamily = 'custom'
    const profile: BrowserProfile = {
      ...draft,
      id: 'profile-transfer-kernel-family',
      serialNumber: 1,
      favorite: false,
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
      status: 'closed'
    }

    const serialized = serializeProfileConfig(profile)
    expect(JSON.parse(serialized).profile).toMatchObject({
      kernelVersion: '144.0.7559.132',
      kernelFamily: 'custom'
    })

    const imported = parseProfileConfig(serialized)
    expect(imported.kernelVersion).toBe('144.0.7559.132')
    expect(imported.kernelFamily).toBe('custom')
  })
})
