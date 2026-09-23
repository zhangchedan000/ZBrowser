import type { IdentityConfigProvenance, IdentityConfigSection } from './types'
import { identityConfigSource } from './identity-config-provenance'
import type { FingerprintConfigReference, FingerprintHealthSignal } from './fingerprint-health-model'

export interface DiagnosticCheckInput {
  key: string
  status: 'pass' | 'warning' | 'error'
  message: string
  value?: unknown
  expected?: unknown
}

interface ConfigTarget {
  section: IdentityConfigSection
  keys: string[]
}

function resolveComponent(key: string): FingerprintHealthSignal['component'] {
  if (key.includes('gpu') || key.includes('webgl') || key.includes('webgpu')) return 'gpu'
  if (key.includes('cpu') || key.includes('memory') || key.includes('screen') || key.includes('hardware')) return 'hardware'
  if (key.includes('timezone') || key.includes('language')) return 'locale'
  if (key.includes('proxy') || key.includes('network') || key.includes('ip')) return 'network'
  if (key.includes('canvas') || key.includes('audio') || key.includes('font')) return 'rendering'
  return 'browser'
}

function resolveConfigTarget(key: string): ConfigTarget | undefined {
  switch (key) {
    case 'runtime-persona-contract':
      return { section: 'fingerprint', keys: ['hardwareProfileId', 'hardwarePersonaId'] }
    case 'runtime-platform':
    case 'runtime-ua-ch-platform':
      return { section: 'fingerprint', keys: ['platform'] }
    case 'runtime-hardware-concurrency':
      return { section: 'fingerprint', keys: ['hardwareConcurrency'] }
    case 'runtime-device-memory':
      return { section: 'fingerprint', keys: ['deviceMemoryGb'] }
    case 'runtime-device-pixel-ratio':
      return { section: 'fingerprint', keys: ['devicePixelRatio'] }
    case 'runtime-screen':
      return { section: 'fingerprint', keys: ['screenWidth', 'screenHeight'] }
    case 'runtime-color-depth':
      return { section: 'fingerprint', keys: ['colorDepth'] }
    case 'runtime-pixel-depth':
      return { section: 'fingerprint', keys: ['pixelDepth'] }
    case 'runtime-language':
      return { section: 'locale', keys: ['language'] }
    case 'runtime-languages-primary':
      return { section: 'locale', keys: ['language', 'acceptLanguages'] }
    case 'runtime-timezone':
      return { section: 'locale', keys: ['timezone'] }
    case 'runtime-system-gpu':
    case 'runtime-webgl-renderer':
    case 'runtime-webgl-vendor':
    case 'runtime-webgpu':
    case 'runtime-webgpu-vendor':
    case 'runtime-webgpu-architecture':
      return { section: 'fingerprint', keys: ['hardwareProfileId', 'hardwarePersonaId', 'gpuBucket'] }
    case 'runtime-font-inventory':
      return { section: 'fingerprint', keys: ['hardwareProfileId', 'hardwarePersonaId'] }
    case 'runtime-ua-ch-architecture':
      return { section: 'fingerprint', keys: ['architecture'] }
    case 'runtime-ua-ch-bitness':
      return { section: 'fingerprint', keys: ['bitness'] }
    default:
      return undefined
  }
}

function resolveReferences(
  key: string,
  provenance?: IdentityConfigProvenance
): FingerprintConfigReference[] {
  const target = resolveConfigTarget(key)
  if (!target) return []
  return target.keys.map((configKey) => ({
    section: target.section,
    key: configKey,
    source: identityConfigSource(provenance, target.section, configKey)
  }))
}

function resolveWeight(status: DiagnosticCheckInput['status']): number {
  if (status === 'error') return 25
  if (status === 'warning') return 10
  return 0
}

export function diagnosticChecksToHealthSignals(
  checks: DiagnosticCheckInput[],
  provenance?: IdentityConfigProvenance
): FingerprintHealthSignal[] {
  return checks
    .filter((check) => check.status !== 'pass')
    .map((check) => ({
      component: resolveComponent(check.key),
      key: check.key,
      value: check.value,
      expected: check.expected,
      weight: resolveWeight(check.status),
      confidence: check.status === 'error' ? 1 : 0.6,
      impact: check.status === 'error' ? 'error' : 'warning',
      evidence: check.message,
      configReferences: resolveReferences(check.key, provenance)
    }))
}
