import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { buildIdentityDriftIntelligence } from '../shared/identity-drift-health'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from '../shared/identity-config-provenance'
import type { AIIdentityGenerationResult } from '../shared/identity-ai-generator'
import { resolveIdentityRepairStrategy } from '../shared/identity-repair-strategy'
import type { IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import type { FingerprintRuntimeDiagnosticReport } from '../shared/types'
import { IdentityBaselineStore } from './identity-baseline-store'
import { evaluateRuntimeIdentity } from './identity-drift-runtime'
import { FingerprintRepairExecutor } from './fingerprint-repair-executor'
import { FingerprintRepairStateStore } from './fingerprint-repair-state'
import { IdentityRepairStrategyExecutor } from './identity-repair-strategy-executor'
import { IdentitySelfHealingManager } from './identity-self-healing-manager'
import { IdentitySelfHealingStateStore } from './identity-self-healing-state'
import { ProfileStore } from './profile-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function snapshot(language: string, timezone = 'America/New_York'): IdentityBaselineSnapshot {
  return {
    browser: { userAgent: 'Chrome/144.0.7559.132', platform: 'Win32' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 },
    gpu: {
      webgl: {
        unmaskedVendor: 'NVIDIA Corporation',
        unmaskedRenderer: 'NVIDIA GeForce RTX 4060'
      }
    },
    rendering: { fonts: { detected: ['Segoe UI'] } },
    network: { ip: '203.0.113.10', countryCode: 'US', timezone: 'America/New_York' },
    locale: { language, timezone }
  }
}

function generatedIdentity(): AIIdentityGenerationResult {
  return {
    config: {
      fingerprint: {},
      network: {
        networkIdentityMode: { value: 'manual', source: 'ai' }
      },
      locale: {
        language: { value: 'en-US', source: 'ai' },
        timezone: { value: 'America/New_York', source: 'ai' }
      },
      browser: {}
    },
    warnings: [],
    networkReadiness: 'manual'
  }
}

describe('auto identity self-healing end-to-end', () => {
  it('flows Auto -> locale drift -> policy -> repair -> runtime verify -> baseline v2 -> Healthy', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-auto-self-healing-'))
    temporaryPaths.push(vault)

    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.fingerprint.language = 'fr-FR'
    draft.fingerprint.timezone = 'Europe/Paris'
    draft.identityIntent = {
      schemaVersion: 1,
      targetCountryCode: 'US',
      strategy: 'ai_assisted',
      selfHealingMode: 'auto'
    }
    draft.identityConfigProvenance = markFingerprintConfigSources(
      emptyIdentityConfigProvenance(),
      ['language', 'timezone'],
      'ai'
    )
    const profile = await profiles.create(draft)
    const baselines = new IdentityBaselineStore(vault)

    const initial = await evaluateRuntimeIdentity(
      baselines,
      profile.id,
      snapshot('fr-FR', 'Europe/Paris'),
      profile.identityConfigProvenance,
      { allowCreateBaseline: true }
    )
    expect(initial.baseline?.version).toBe(1)

    const observed = await evaluateRuntimeIdentity(
      baselines,
      profile.id,
      snapshot('en-US'),
      profile.identityConfigProvenance,
      { allowCreateBaseline: false }
    )
    expect(observed.drift?.driftDetected).toBe(true)
    expect(observed.baseline?.status).toBe('stale')

    const intelligence = buildIdentityDriftIntelligence(
      observed.drift!,
      snapshot('en-US'),
      profile.identityConfigProvenance
    )
    const repairStrategy = resolveIdentityRepairStrategy({
      drift: observed.drift,
      diagnosis: intelligence.diagnosis,
      baselineStatus: observed.baseline?.status
    })
    expect(repairStrategy).toMatchObject({
      kind: 'repair_configuration',
      automaticActionAvailable: true,
      affectedSections: ['locale']
    })

    const driftReport: FingerprintRuntimeDiagnosticReport = {
      profileId: profile.id,
      checkedAt: new Date().toISOString(),
      ready: false,
      identitySnapshot: snapshot('en-US'),
      identityBaseline: observed.baseline ? {
        id: observed.baseline.id,
        version: observed.baseline.version,
        status: observed.baseline.status,
        lastVerifiedAt: observed.baseline.lastVerifiedAt
      } : undefined,
      identityDrift: observed.drift,
      identityHealth: intelligence.health,
      identityDiagnosis: intelligence.diagnosis,
      identityRepairStrategy: repairStrategy,
      checks: []
    }

    const healthyDrift = {
      profileId: profile.id,
      baselineId: observed.baseline!.id,
      driftDetected: false,
      severity: 'low' as const,
      confidence: 1,
      changes: [],
      generatedAt: new Date().toISOString()
    }
    const healthyIntelligence = buildIdentityDriftIntelligence(
      healthyDrift,
      snapshot('en-US'),
      profile.identityConfigProvenance
    )
    const healthyReport: FingerprintRuntimeDiagnosticReport = {
      profileId: profile.id,
      checkedAt: new Date().toISOString(),
      ready: true,
      identityCapturedAt: new Date().toISOString(),
      identitySnapshot: snapshot('en-US'),
      identityDrift: healthyDrift,
      identityHealth: healthyIntelligence.health,
      identityDiagnosis: healthyIntelligence.diagnosis,
      identityRepairStrategy: resolveIdentityRepairStrategy({
        drift: healthyDrift,
        diagnosis: healthyIntelligence.diagnosis,
        baselineStatus: 'active'
      }),
      checks: [{ key: 'runtime-locale', label: 'Locale', status: 'pass', message: 'matched' }]
    }

    let verificationCalls = 0
    const verifier = {
      diagnoseFingerprintRuntime: async (): Promise<FingerprintRuntimeDiagnosticReport> => {
        verificationCalls += 1
        return verificationCalls <= 3 ? driftReport : healthyReport
      }
    }

    const fingerprintRepair = new FingerprintRepairExecutor(
      profiles,
      verifier,
      new FingerprintRepairStateStore(profiles),
      undefined,
      () => generatedIdentity()
    )
    const strategyExecutor = new IdentityRepairStrategyExecutor(
      profiles,
      verifier,
      {
        async test() { throw new Error('proxy pool should not be used for locale repair') },
        check() { return undefined },
        proxyConfig() { return { protocol: 'direct' as const, host: '', port: 0, username: '', password: '' } }
      },
      fingerprintRepair
    )
    const selfHealing = new IdentitySelfHealingManager(
      profiles,
      verifier,
      strategyExecutor,
      new IdentitySelfHealingStateStore(vault)
    )

    const result = await selfHealing.diagnose(profile.id)

    expect(verificationCalls).toBeGreaterThanOrEqual(4)
    expect(result.ready).toBe(true)
    expect(result.identitySelfHealing).toMatchObject({
      mode: 'auto',
      decision: 'auto_execute',
      pending: false,
      lastResult: 'completed',
      lastStrategyKind: 'repair_configuration'
    })
    expect(profiles.get(profile.id).fingerprint.language).toBe('en-US')
    expect(profiles.get(profile.id).fingerprint.timezone).toBe('America/New_York')

    const current = await baselines.get(profile.id)
    const history = await baselines.history(profile.id)
    expect(current?.version).toBe(2)
    expect(current?.status).toBe('active')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ version: 1, status: 'replaced' })
    expect(result.identityHealth?.score).toBe(100)
    expect(result.identityHealth?.risk).toBe('low')
  })
})
