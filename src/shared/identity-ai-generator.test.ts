import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { generateAIIdentityConfig } from './identity-ai-generator'
import { resolveIdentityConfig, type IdentityConfigProfile } from './identity-config-engine'

function windowsBase() {
  return {
    ...defaultFingerprint(12345),
    platform: 'windows' as const,
    platformVersion: '10.0.0'
  }
}

describe('generateAIIdentityConfig', () => {
  it('generates coherent AI fingerprint and network identity from a checked US proxy', () => {
    const result = generateAIIdentityConfig({
      baseFingerprint: windowsBase(),
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: {
        ok: true,
        ip: '203.0.113.10',
        latencyMs: 85,
        countryCode: 'US',
        timezone: 'America/New_York',
        latitude: 40.7128,
        longitude: -74.006,
        accuracyMeters: 25000,
        asn: 64500,
        organization: 'Example ISP',
        isp: 'Example ISP',
        geoConfidence: 'consensus'
      }
    })

    expect(result.networkReadiness).toBe('ready')
    expect(result.personaId).toBeTruthy()
    expect(result.config.fingerprint.hardwarePersonaId?.source).toBe('ai')
    expect(result.config.network.networkIdentityMode.value).toBe('proxy')
    expect(result.config.network.webrtcPolicy.value).toBe('proxy_only')
    expect(result.config.locale.language.value).toBe('en-US')
    expect(result.config.locale.timezone.value).toBe('America/New_York')
  })

  it('keeps manual network mode available without forcing proxy-derived settings', () => {
    const base = windowsBase()
    base.language = 'de-DE'
    base.acceptLanguages = 'de-DE,de,en-US,en'
    base.timezone = 'Europe/Berlin'

    const result = generateAIIdentityConfig({
      baseFingerprint: base,
      platform: 'windows',
      networkMode: 'manual',
      countryCode: 'DE',
      proxyProtocol: 'direct'
    })

    expect(result.networkReadiness).toBe('manual')
    expect(result.config.network.networkIdentityMode.value).toBe('manual')
    expect(result.config.locale.language.value).toBe('de-DE')
    expect(result.config.locale.timezone.value).toBe('Europe/Berlin')
  })

  it('preserves a user manual override above the AI generated value', () => {
    const generated = generateAIIdentityConfig({
      baseFingerprint: windowsBase(),
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: {
        ok: true,
        ip: '203.0.113.10',
        latencyMs: 85,
        countryCode: 'US',
        timezone: 'America/New_York',
        latitude: 40.7128,
        longitude: -74.006,
        geoConfidence: 'consensus'
      }
    })

    const defaults: IdentityConfigProfile = {
      fingerprint: {},
      network: {},
      locale: {},
      browser: {}
    }

    const resolved = resolveIdentityConfig(defaults, generated.config, {
      locale: {
        timezone: {
          value: 'America/Los_Angeles',
          source: 'user'
        }
      }
    })

    expect(resolved.locale.timezone.value).toBe('America/Los_Angeles')
    expect(resolved.locale.timezone.source).toBe('user')
  })
})
