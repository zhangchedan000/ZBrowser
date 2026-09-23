import type { IdentityBaselineSnapshot, IdentityDriftChange, IdentityDriftReport } from './identity-baseline-model'
import { buildAIDiagnosisContext } from './fingerprint-ai-diagnosis'
import { buildFingerprintHealthModel } from './fingerprint-health-aggregator'
import type {
  AIDiagnosisContext,
  FingerprintConfigReference,
  FingerprintHealthModel,
  FingerprintHealthSignal
} from './fingerprint-health-model'
import { identityConfigSource } from './identity-config-provenance'
import type { IdentityConfigProvenance, IdentityConfigSection } from './types'

export interface IdentityDriftIntelligence {
  health: FingerprintHealthModel
  diagnosis: AIDiagnosisContext
}

interface ConfigTarget {
  section: IdentityConfigSection
  keys: string[]
}

function targetFor(change: IdentityDriftChange): ConfigTarget | undefined {
  switch (change.component) {
    case 'hardware':
      if (change.field === 'hardwareConcurrency') return { section: 'fingerprint', keys: ['hardwareConcurrency'] }
      if (change.field === 'deviceMemory') return { section: 'fingerprint', keys: ['deviceMemoryGb'] }
      if (change.field === 'devicePixelRatio') return { section: 'fingerprint', keys: ['devicePixelRatio'] }
      if (change.field === 'screen.width' || change.field === 'screen.availWidth') {
        return { section: 'fingerprint', keys: ['screenWidth'] }
      }
      if (change.field === 'screen.height' || change.field === 'screen.availHeight') {
        return { section: 'fingerprint', keys: ['screenHeight'] }
      }
      if (change.field === 'screen.colorDepth') return { section: 'fingerprint', keys: ['colorDepth'] }
      if (change.field === 'screen.pixelDepth') return { section: 'fingerprint', keys: ['pixelDepth'] }
      return { section: 'fingerprint', keys: ['hardwareProfileId', 'hardwarePersonaId'] }
    case 'gpu':
      return { section: 'fingerprint', keys: ['hardwareProfileId', 'hardwarePersonaId', 'gpuBucket'] }
    case 'rendering':
      return { section: 'fingerprint', keys: ['hardwareProfileId', 'hardwarePersonaId'] }
    case 'network':
      return { section: 'network', keys: ['networkIdentityMode', 'proxyExitPolicy'] }
    case 'locale':
      if (change.field === 'timezone') return { section: 'locale', keys: ['timezone'] }
      if (change.field === 'language') return { section: 'locale', keys: ['language'] }
      if (change.field === 'languages') return { section: 'locale', keys: ['language', 'acceptLanguages'] }
      return { section: 'locale', keys: ['language', 'timezone'] }
    case 'browser':
      if (change.field.includes('architecture')) return { section: 'fingerprint', keys: ['architecture'] }
      if (change.field.includes('bitness')) return { section: 'fingerprint', keys: ['bitness'] }
      if (change.field.includes('platform')) return { section: 'fingerprint', keys: ['platform'] }
      return { section: 'browser', keys: ['brand', 'brandVersion'] }
    default:
      return undefined
  }
}

function referencesFor(
  change: IdentityDriftChange,
  provenance?: IdentityConfigProvenance
): FingerprintConfigReference[] {
  const target = targetFor(change)
  if (!target) return []

  return target.keys.map((key) => ({
    section: target.section,
    key,
    source: identityConfigSource(provenance, target.section, key)
  }))
}

function weightFor(severity: IdentityDriftChange['severity']): number {
  if (severity === 'critical') return 70
  if (severity === 'high') return 45
  if (severity === 'medium') return 25
  return 5
}

function impactFor(severity: IdentityDriftChange['severity']): FingerprintHealthSignal['impact'] {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'info'
}

export function identityDriftToHealthSignals(
  report: IdentityDriftReport,
  provenance?: IdentityConfigProvenance
): FingerprintHealthSignal[] {
  return report.changes.map((change) => ({
    component: change.component,
    key: `identity-drift:${change.component}.${change.field}`,
    value: change.after,
    expected: change.before,
    weight: weightFor(change.severity),
    confidence: report.confidence,
    impact: impactFor(change.severity),
    evidence: `${change.component}.${change.field} changed from baseline`,
    configReferences: referencesFor(change, provenance)
  }))
}

export function buildIdentityDriftIntelligence(
  report: IdentityDriftReport,
  snapshot: IdentityBaselineSnapshot,
  provenance?: IdentityConfigProvenance
): IdentityDriftIntelligence {
  const health = buildFingerprintHealthModel(
    identityDriftToHealthSignals(report, provenance),
    snapshot
  )

  return {
    health,
    diagnosis: buildAIDiagnosisContext(health)
  }
}
