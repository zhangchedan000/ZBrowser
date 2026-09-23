import type {
  IdentityConfigProvenance,
  IdentityConfigSection,
  IdentityConfigSource
} from './types'

export const HARDWARE_IDENTITY_FIELDS = [
  'hardwareProfileId',
  'hardwarePersonaId',
  'gpuBucket',
  'renderIdentityVersion',
  'platform',
  'platformVersion',
  'hardwareConcurrency',
  'screenWidth',
  'screenHeight',
  'architecture',
  'bitness',
  'deviceMemoryGb',
  'devicePixelRatio',
  'colorDepth',
  'pixelDepth'
] as const

const NETWORK_FIELDS = new Set(['networkIdentityMode', 'proxyExitPolicy', 'webrtcPolicy'])
const LOCALE_FIELDS = new Set(['language', 'acceptLanguages', 'timezone'])
const BROWSER_FIELDS = new Set(['brand', 'brandVersion'])
const VALID_SOURCE = new Set<IdentityConfigSource>(['default', 'ai', 'user'])
const VALID_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/

export function emptyIdentityConfigProvenance(): IdentityConfigProvenance {
  return {
    schemaVersion: 1,
    fingerprint: {},
    network: {},
    locale: {},
    browser: {}
  }
}

export function normalizeIdentityConfigProvenance(value: unknown): IdentityConfigProvenance {
  const result = emptyIdentityConfigProvenance()
  if (!value || typeof value !== 'object') return result
  const raw = value as Partial<Record<IdentityConfigSection, unknown>>

  for (const section of ['fingerprint', 'network', 'locale', 'browser'] as const) {
    const candidate = raw[section]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    for (const [key, source] of Object.entries(candidate)) {
      if (!VALID_KEY.test(key) || !VALID_SOURCE.has(source as IdentityConfigSource)) continue
      result[section][key] = source as IdentityConfigSource
    }
  }

  return result
}

export function identityConfigSource(
  provenance: IdentityConfigProvenance | undefined,
  section: IdentityConfigSection,
  key: string
): IdentityConfigSource {
  return provenance?.[section]?.[key] ?? 'default'
}

export function identitySectionForFingerprintField(key: string): IdentityConfigSection {
  if (NETWORK_FIELDS.has(key)) return 'network'
  if (LOCALE_FIELDS.has(key)) return 'locale'
  if (BROWSER_FIELDS.has(key)) return 'browser'
  return 'fingerprint'
}

export function markIdentityConfigFields(
  provenance: IdentityConfigProvenance | undefined,
  section: IdentityConfigSection,
  keys: readonly string[],
  source: IdentityConfigSource,
  preserveUser = false
): IdentityConfigProvenance {
  const next = normalizeIdentityConfigProvenance(provenance)
  for (const key of keys) {
    if (!VALID_KEY.test(key)) continue
    if (preserveUser && next[section][key] === 'user') continue
    next[section][key] = source
  }
  return next
}

export function markFingerprintConfigSources(
  provenance: IdentityConfigProvenance | undefined,
  keys: readonly string[],
  source: IdentityConfigSource
): IdentityConfigProvenance {
  let next = normalizeIdentityConfigProvenance(provenance)
  for (const key of keys) {
    next = markIdentityConfigFields(next, identitySectionForFingerprintField(key), [key], source)
    if (source === 'user' && key === 'hardwareProfileId') {
      next = markIdentityConfigFields(next, 'fingerprint', HARDWARE_IDENTITY_FIELDS, 'user')
    }
  }
  return next
}
