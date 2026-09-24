import { describe, expect, it } from 'vitest'
import type { IdentityBaselineSnapshot } from './identity-baseline-model'
import { evaluateIdentityIntentConsistency, identityIntentConsistencyChecks } from './identity-intent-consistency'

function snapshot(countryCode?: string): IdentityBaselineSnapshot {
  return {
    browser: {},
    hardware: {},
    gpu: {},
    rendering: {},
    network: countryCode ? { countryCode } : {},
    locale: {}
  }
}

describe('Identity Intent consistency', () => {
  it('aligns target, proxy, runtime and baseline country', () => {
    const result = evaluateIdentityIntentConsistency({
      intent: { schemaVersion: 1, targetCountryCode: 'US', strategy: 'ai_assisted' },
      proxyProtocol: 'http',
      proxyCheck: { ok: true, latencyMs: 10, countryCode: 'US', checkedAt: '2026-09-24T00:00:00.000Z' },
      runtimeSnapshot: snapshot('US'),
      baselineSnapshot: snapshot('US')
    })
    expect(result.status).toBe('aligned')
    expect(identityIntentConsistencyChecks(result).every((check) => check.status === 'pass')).toBe(true)
  })

  it('blocks a proxied runtime when the proxy country differs from intent', () => {
    const result = evaluateIdentityIntentConsistency({
      intent: { schemaVersion: 1, targetCountryCode: 'DE', strategy: 'manual' },
      proxyProtocol: 'socks5',
      proxyCheck: { ok: true, latencyMs: 10, countryCode: 'US', checkedAt: '2026-09-24T00:00:00.000Z' },
      runtimeSnapshot: snapshot('US')
    })
    expect(result.status).toBe('mismatch')
    expect(identityIntentConsistencyChecks(result).some((check) => check.status === 'error')).toBe(true)
  })

  it('keeps direct mode unverified instead of failing without network country evidence', () => {
    const result = evaluateIdentityIntentConsistency({
      intent: { schemaVersion: 1, targetCountryCode: 'GB', strategy: 'manual' },
      proxyProtocol: 'direct',
      runtimeSnapshot: snapshot()
    })
    expect(result.status).toBe('unverified')
    expect(identityIntentConsistencyChecks(result).every((check) => check.status !== 'error')).toBe(true)
  })
})
