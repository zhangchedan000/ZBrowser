import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { applyAIIdentityConfigProvenance, applyAIIdentityConfigToFingerprint, generateAIIdentityConfig } from './identity-ai-generator'
import { resolveIdentityConfig, type IdentityConfigProfile } from './identity-config-engine'
import { applyHardwareProfile } from './hardware-profiles'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from './identity-config-provenance'

function windowsBase() {
  return {
    ...defaultFingerprint(12345),
    platform: 'windows' as const,
    platformVersion: '10.0.0'
  }
}

function usProxyCheck() {
  return {
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
    geoConfidence: 'consensus' as const
  }
}

describe('generateAIIdentityConfig', () => {
  it('generates coherent AI fingerprint and network identity from a checked US proxy', () => {
    const result = generateAIIdentityConfig({
      baseFingerprint: windowsBase(),
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: usProxyCheck()
    })

    expect(result.networkReadiness).toBe('ready')
    expect(result.personaId).toBeTruthy()
    expect(result.config.fingerprint.hardwarePersonaId?.source).toBe('ai')
    expect(result.config.network.networkIdentityMode.value).toBe('proxy')
    expect(result.config.network.webrtcPolicy.value).toBe('proxy_only')
    expect(result.config.locale.language.value).toBe('en-US')
    expect(result.config.locale.timezone.value).toBe('America/New_York')
  })

  it('materializes the AI recommendation into a coherent runtime fingerprint config', () => {
    const base = windowsBase()
    const generated = generateAIIdentityConfig({
      baseFingerprint: base,
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: usProxyCheck()
    })
    const applied = applyAIIdentityConfigToFingerprint(base, generated)

    expect(applied.hardwarePersonaId).toBe(generated.personaId)
    expect(applied.networkIdentityMode).toBe('proxy')
    expect(applied.proxyExitPolicy).toBe('block')
    expect(applied.webrtcPolicy).toBe('proxy_only')
    expect(applied.language).toBe('en-US')
    expect(applied.timezone).toBe('America/New_York')
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

    const applied = applyAIIdentityConfigToFingerprint(base, result)

    expect(result.networkReadiness).toBe('manual')
    expect(result.config.network.networkIdentityMode.value).toBe('manual')
    expect(applied.networkIdentityMode).toBe('manual')
    expect(applied.language).toBe('de-DE')
    expect(applied.timezone).toBe('Europe/Berlin')
  })

  it('does not overwrite manual network values when proxy identity is not trustworthy', () => {
    const base = windowsBase()
    base.networkIdentityMode = 'manual'
    base.language = 'de-DE'
    base.acceptLanguages = 'de-DE,de,en-US,en'
    base.timezone = 'Europe/Berlin'

    const generated = generateAIIdentityConfig({
      baseFingerprint: base,
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: {
        ...usProxyCheck(),
        geoConfidence: 'conflict',
        geoConflict: 'country/timezone providers disagree'
      }
    })
    const applied = applyAIIdentityConfigToFingerprint(base, generated)

    expect(generated.networkReadiness).toBe('conflict')
    expect(applied.networkIdentityMode).toBe('manual')
    expect(applied.language).toBe('de-DE')
    expect(applied.timezone).toBe('Europe/Berlin')
  })

  it('allows the user to detach from an AI persona and continue with manual hardware values', () => {
    const base = windowsBase()
    const generated = generateAIIdentityConfig({
      baseFingerprint: base,
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: usProxyCheck()
    })
    const aiApplied = applyAIIdentityConfigToFingerprint(base, generated)
    const manual = applyHardwareProfile(aiApplied, 'legacy-custom')
    const edited = {
      ...manual,
      hardwareConcurrency: 12,
      screenWidth: 1600,
      screenHeight: 900
    }

    expect(manual.hardwareProfileId).toBe('legacy-custom')
    expect(manual.hardwarePersonaId).toBeUndefined()
    expect(edited.hardwareConcurrency).toBe(12)
    expect(edited.screenWidth).toBe(1600)
    expect(edited.screenHeight).toBe(900)
  })

  it('does not overwrite persisted user locale overrides when AI is run again', () => {
    const base = windowsBase()
    base.timezone = 'America/Los_Angeles'
    const provenance = markFingerprintConfigSources(emptyIdentityConfigProvenance(), ['timezone'], 'user')
    const generated = generateAIIdentityConfig({
      baseFingerprint: base,
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: usProxyCheck()
    })

    const applied = applyAIIdentityConfigToFingerprint(base, generated, provenance)
    const nextProvenance = applyAIIdentityConfigProvenance(provenance, generated)

    expect(applied.timezone).toBe('America/Los_Angeles')
    expect(nextProvenance.locale.timezone).toBe('user')
    expect(nextProvenance.locale.language).toBe('ai')
  })

  it('does not replace manual hardware after the user detaches from an AI Persona', () => {
    const base = applyHardwareProfile(windowsBase(), 'legacy-custom')
    base.hardwareConcurrency = 12
    base.screenWidth = 1600
    base.screenHeight = 900
    const provenance = markFingerprintConfigSources(emptyIdentityConfigProvenance(), ['hardwareProfileId'], 'user')
    const generated = generateAIIdentityConfig({
      baseFingerprint: base,
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: usProxyCheck()
    })

    const applied = applyAIIdentityConfigToFingerprint(base, generated, provenance)

    expect(applied.hardwareProfileId).toBe('legacy-custom')
    expect(applied.hardwareConcurrency).toBe(12)
    expect(applied.screenWidth).toBe(1600)
    expect(applied.screenHeight).toBe(900)
  })

  it('preserves a user manual override above the AI generated value', () => {
    const generated = generateAIIdentityConfig({
      baseFingerprint: windowsBase(),
      platform: 'windows',
      networkMode: 'proxy',
      proxyProtocol: 'http',
      proxyCheck: usProxyCheck()
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
