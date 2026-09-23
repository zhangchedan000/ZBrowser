import { describe, expect, it } from 'vitest'
import type { IdentityBaselineSnapshot, IdentityDriftReport } from './identity-baseline-model'
import {
  buildIdentityDriftIntelligence,
  identityDriftToHealthSignals
} from './identity-drift-health'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from './identity-config-provenance'

const snapshot: IdentityBaselineSnapshot = {
  browser: { platform: 'Win32' },
  hardware: { hardwareConcurrency: 8 },
  gpu: { webgl: { unmaskedRenderer: 'Google SwiftShader' } },
  rendering: { fonts: { detected: ['Segoe UI'] } },
  network: { ip: '203.0.113.10' },
  locale: { language: 'en-US', timezone: 'America/New_York' }
}

function report(
  changes: IdentityDriftReport['changes'],
  severity: IdentityDriftReport['severity']
): IdentityDriftReport {
  return {
    profileId: 'profile-1',
    baselineId: 'baseline-1',
    driftDetected: changes.length > 0,
    severity,
    confidence: changes.length ? 0.95 : 1,
    changes,
    generatedAt: '2026-09-23T09:00:00.000Z'
  }
}

describe('identity drift health intelligence', () => {
  it('keeps a no-drift comparison healthy', () => {
    const result = buildIdentityDriftIntelligence(report([], 'low'), snapshot)

    expect(result.health.score).toBe(100)
    expect(result.health.risk).toBe('low')
    expect(result.diagnosis.issues).toHaveLength(0)
    expect(result.diagnosis.requiresUserConfirmation).toBe(false)
  })

  it('turns a critical GPU drift into critical health and AI diagnosis', () => {
    let provenance = emptyIdentityConfigProvenance()
    provenance = markFingerprintConfigSources(provenance, ['gpuBucket'], 'user')
    const drift = report([{
      component: 'gpu',
      field: 'webgl.unmaskedRenderer',
      before: 'NVIDIA GeForce RTX 4060',
      after: 'Google SwiftShader',
      severity: 'critical'
    }], 'critical')

    const result = buildIdentityDriftIntelligence(drift, snapshot, provenance)

    expect(result.health.risk).toBe('critical')
    expect(result.health.score).toBeLessThan(40)
    expect(result.diagnosis.risks.some((risk) => risk.startsWith('gpu:'))).toBe(true)
    expect(result.diagnosis.suggestedActions).toContain('检查 GPU Persona 与实际运行环境是否一致')
    expect(result.diagnosis.protectedUserOverrides).toBe(1)
    expect(result.diagnosis.issues[0]?.repairPolicy).toBe('suggest_only')
  })

  it('maps locale drift to the existing provenance fields', () => {
    let provenance = emptyIdentityConfigProvenance()
    provenance = markFingerprintConfigSources(provenance, ['timezone'], 'ai')
    const signals = identityDriftToHealthSignals(report([{
      component: 'locale',
      field: 'timezone',
      before: 'America/New_York',
      after: 'America/Los_Angeles',
      severity: 'medium'
    }], 'medium'), provenance)

    expect(signals[0]?.component).toBe('locale')
    expect(signals[0]?.configReferences).toEqual([{
      section: 'locale',
      key: 'timezone',
      source: 'ai'
    }])
  })

  it('maps a network drift to high health risk', () => {
    const result = buildIdentityDriftIntelligence(report([{
      component: 'network',
      field: 'ip',
      before: '203.0.113.10',
      after: '198.51.100.20',
      severity: 'high'
    }], 'high'), snapshot)

    expect(result.health.risk).toBe('high')
    expect(result.health.components[0]?.component).toBe('network')
  })
})
