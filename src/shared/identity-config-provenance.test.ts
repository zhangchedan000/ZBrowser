import { describe, expect, it } from 'vitest'
import {
  emptyIdentityConfigProvenance,
  identityConfigSource,
  markFingerprintConfigSources,
  normalizeIdentityConfigProvenance
} from './identity-config-provenance'

describe('identity config provenance', () => {
  it('treats missing provenance as default and filters invalid persisted values', () => {
    const normalized = normalizeIdentityConfigProvenance({
      schemaVersion: 99,
      locale: { timezone: 'user', language: 'invalid' },
      network: { networkIdentityMode: 'ai' },
      fingerprint: { 'bad key': 'user' }
    })

    expect(identityConfigSource(undefined, 'locale', 'timezone')).toBe('default')
    expect(normalized.locale.timezone).toBe('user')
    expect(normalized.locale.language).toBeUndefined()
    expect(normalized.network.networkIdentityMode).toBe('ai')
    expect(normalized.fingerprint['bad key']).toBeUndefined()
  })

  it('maps fingerprint form fields to their identity sections', () => {
    let provenance = emptyIdentityConfigProvenance()
    provenance = markFingerprintConfigSources(provenance, ['timezone', 'webrtcPolicy', 'brandVersion', 'screenWidth'], 'user')

    expect(provenance.locale.timezone).toBe('user')
    expect(provenance.network.webrtcPolicy).toBe('user')
    expect(provenance.browser.brandVersion).toBe('user')
    expect(provenance.fingerprint.screenWidth).toBe('user')
  })

  it('locks the full hardware identity when the user switches to manual hardware', () => {
    const provenance = markFingerprintConfigSources(emptyIdentityConfigProvenance(), ['hardwareProfileId'], 'user')

    expect(provenance.fingerprint.hardwareProfileId).toBe('user')
    expect(provenance.fingerprint.hardwareConcurrency).toBe('user')
    expect(provenance.fingerprint.screenWidth).toBe('user')
    expect(provenance.fingerprint.hardwarePersonaId).toBe('user')
  })
})
