import { describe, expect, it } from 'vitest'
import { analyzeIdentityEnvironment } from './identity-environment-analysis'

function proxy(countryCode = 'US') {
  return {
    ok: true,
    ip: '203.0.113.10',
    latencyMs: 50,
    countryCode,
    timezone: 'America/New_York',
    latitude: 40.7128,
    longitude: -74.006,
    geoConfidence: 'consensus' as const
  }
}

describe('analyzeIdentityEnvironment', () => {
  it('accepts a checked proxy when its exit country matches the target', () => {
    expect(analyzeIdentityEnvironment({
      targetCountryCode: 'us',
      proxyProtocol: 'http',
      proxyCheck: proxy('US')
    })).toEqual({
      status: 'ready',
      canGenerate: true,
      targetCountryCode: 'US',
      observedCountryCode: 'US',
      effectiveCountryCode: 'US',
      warnings: []
    })
  })

  it('blocks AI generation when the proxy exits from another country', () => {
    const result = analyzeIdentityEnvironment({
      targetCountryCode: 'DE',
      proxyProtocol: 'socks5',
      proxyCheck: proxy('US')
    })

    expect(result.status).toBe('country_mismatch')
    expect(result.canGenerate).toBe(false)
    expect(result.warnings[0]).toContain('DE')
    expect(result.warnings[0]).toContain('US')
  })

  it('blocks generation when GeoIP sources conflict', () => {
    const result = analyzeIdentityEnvironment({
      targetCountryCode: 'US',
      proxyProtocol: 'http',
      proxyCheck: {
        ...proxy('US'),
        geoConfidence: 'conflict',
        geoConflict: 'country providers disagree'
      }
    })

    expect(result.status).toBe('geo_conflict')
    expect(result.canGenerate).toBe(false)
  })

  it('allows direct/manual generation to use an explicit target country', () => {
    const result = analyzeIdentityEnvironment({
      targetCountryCode: 'DE',
      proxyProtocol: 'direct'
    })

    expect(result.status).toBe('manual')
    expect(result.canGenerate).toBe(true)
    expect(result.effectiveCountryCode).toBe('DE')
  })

  it('rejects malformed target country codes', () => {
    const result = analyzeIdentityEnvironment({
      targetCountryCode: 'USA',
      proxyProtocol: 'direct'
    })

    expect(result.status).toBe('invalid_target')
    expect(result.canGenerate).toBe(false)
  })
})
