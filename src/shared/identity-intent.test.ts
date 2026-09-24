import { describe, expect, it } from 'vitest'
import { normalizeIdentityIntent } from './identity-intent'

describe('normalizeIdentityIntent', () => {
  it('defaults legacy profiles to assisted self-healing', () => {
    expect(normalizeIdentityIntent({
      schemaVersion: 1,
      targetCountryCode: 'us',
      strategy: 'ai_assisted'
    })).toMatchObject({
      targetCountryCode: 'US',
      strategy: 'ai_assisted',
      selfHealingMode: 'assisted'
    })
  })

  it('preserves an explicit auto mode', () => {
    expect(normalizeIdentityIntent({
      schemaVersion: 1,
      targetCountryCode: 'DE',
      strategy: 'manual',
      selfHealingMode: 'auto'
    }).selfHealingMode).toBe('auto')
  })
})
