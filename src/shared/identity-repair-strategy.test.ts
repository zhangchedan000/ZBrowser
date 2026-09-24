import { describe, expect, it } from 'vitest'
import { resolveIdentityRepairStrategy } from './identity-repair-strategy'

describe('resolveIdentityRepairStrategy', () => {
  it('chooses proxy switching when the proxy country violates the target intent', () => {
    const strategy = resolveIdentityRepairStrategy({
      consistency: {
        status: 'mismatch',
        targetCountryCode: 'US',
        proxyCountryCode: 'DE',
        runtimeCountryCode: 'DE',
        warnings: ['mismatch']
      },
      replacementProxy: { id: 'proxy-us', name: 'US 1', countryCode: 'US', score: 96 }
    })
    expect(strategy.kind).toBe('switch_proxy')
    expect(strategy.candidateProxy?.id).toBe('proxy-us')
    expect(strategy.automaticActionAvailable).toBe(true)
  })

  it('chooses baseline replacement when runtime now matches intent but baseline is old', () => {
    const strategy = resolveIdentityRepairStrategy({
      consistency: {
        status: 'mismatch',
        targetCountryCode: 'US',
        proxyCountryCode: 'US',
        runtimeCountryCode: 'US',
        baselineCountryCode: 'DE',
        warnings: ['baseline mismatch']
      },
      baselineStatus: 'stale'
    })
    expect(strategy.kind).toBe('replace_baseline')
    expect(strategy.requiresUserConfirmation).toBe(false)
  })

  it('regenerates a complete identity for hardware/gpu drift', () => {
    const strategy = resolveIdentityRepairStrategy({
      drift: {
        profileId: 'p1',
        baselineId: 'b1',
        driftDetected: true,
        severity: 'critical',
        confidence: 1,
        changes: [{
          component: 'gpu',
          field: 'webgl.unmaskedRenderer',
          before: 'RTX 4060',
          after: 'SwiftShader',
          severity: 'critical'
        }],
        generatedAt: '2026-09-24T00:00:00.000Z'
      }
    })
    expect(strategy.kind).toBe('regenerate_identity')
    expect(strategy.affectedSections).toContain('fingerprint')
  })

  it('uses minimum configuration repair for locale drift', () => {
    const strategy = resolveIdentityRepairStrategy({
      drift: {
        profileId: 'p1',
        baselineId: 'b1',
        driftDetected: true,
        severity: 'medium',
        confidence: 1,
        changes: [{
          component: 'locale',
          field: 'timezone',
          before: 'America/New_York',
          after: 'Europe/Berlin',
          severity: 'medium'
        }],
        generatedAt: '2026-09-24T00:00:00.000Z'
      }
    })
    expect(strategy.kind).toBe('repair_configuration')
    expect(strategy.affectedSections).toEqual(['locale'])
  })
})
