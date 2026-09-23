import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { buildIdentityDriftIntelligence } from '../shared/identity-drift-health'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from '../shared/identity-config-provenance'
import type { AIIdentityGenerationResult } from '../shared/identity-ai-generator'
import type { FingerprintRuntimeDiagnosticReport } from '../shared/types'
import type { IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import { IdentityBaselineStore } from './identity-baseline-store'
import { evaluateRuntimeIdentity } from './identity-drift-runtime'
import { FingerprintRepairExecutor } from './fingerprint-repair-executor'
import { FingerprintRepairStateStore } from './fingerprint-repair-state'
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

describe('identity self-healing end-to-end', () => {
  it('flows baseline -> drift -> health -> diagnosis -> repair -> verify -> baseline v2 -> healthy', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-self-healing-'))
    temporaryPaths.push(vault)

    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.fingerprint.language = 'fr-FR'
    draft.fingerprint.timezone = 'Europe/Paris'
    draft.identityConfigProvenance = markFingerprintConfigSources(
      emptyIdentityConfigProvenance(),
      ['language', 'timezone'],
      'ai'
    )
    const profile = await profiles.create(draft)
    const baselines = new IdentityBaselineStore(profiles.vaultPath)

    const initial = await evaluateRuntimeIdentity(
      baselines,
      profile.id,
      snapshot('fr-FR', 'Europe/Paris'),
      profile.identityConfigProvenance,
      { allowCreateBaseline: true }
    )
    expect(initial.baselineCreated).toBe(true)
    expect(initial.baseline?.version).toBe(1)

    const observed = await evaluateRuntimeIdentity(
      baselines,
      profile.id,
      snapshot('en-US'),
      profile.identityConfigProvenance,
      { allowCreateBaseline: false }
    )
    expect(observed.drift?.driftDetected).toBe(true)
    expect(observed.drift?.severity).toBe('medium')
    expect(observed.baseline?.status).toBe('stale')

    const intelligence = buildIdentityDriftIntelligence(
      observed.drift!,
      snapshot('en-US'),
      profile.identityConfigProvenance
    )
    expect(intelligence.health.score).toBeLessThan(100)
    expect(intelligence.health.risk).toBe('medium')
    expect(intelligence.diagnosis.issues.map((issue) => issue.key))
      .toEqual(expect.arrayContaining([
        'identity-drift:locale.language',
        'identity-drift:locale.timezone'
      ]))
    expect(intelligence.diagnosis.issues.every((issue) => issue.repairPolicy === 'confirm_apply')).toBe(true)

    let verificationCalls = 0
    const executor = new FingerprintRepairExecutor(
      profiles,
      {
        diagnoseFingerprintRuntime: async (id): Promise<FingerprintRuntimeDiagnosticReport> => {
          verificationCalls += 1
          if (verificationCalls === 1) {
            return {
              profileId: id,
              checkedAt: new Date().toISOString(),
              ready: false,
              identitySnapshot: snapshot('en-US'),
              identityDrift: observed.drift,
              identityHealth: intelligence.health,
              identityDiagnosis: intelligence.diagnosis,
              checks: []
            }
          }
          return {
            profileId: id,
            checkedAt: new Date().toISOString(),
            ready: true,
            identityCapturedAt: new Date().toISOString(),
            identitySnapshot: snapshot('en-US'),
            checks: [{ key: 'runtime-language', label: 'Language', status: 'pass', message: 'matched' }]
          }
        }
      },
      new FingerprintRepairStateStore(profiles),
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)
    expect(plan.status).toBe('ready')
    expect(plan.diagnosedIssueKeys).toEqual(expect.arrayContaining([
      'identity-drift:locale.language',
      'identity-drift:locale.timezone'
    ]))
    expect(plan.changes.map((change) => change.field)).toEqual(['language', 'timezone'])

    const repaired = await executor.execute(profile.id, true, plan.planId, ['locale'])
    expect(repaired.status).toBe('completed')
    expect(profiles.get(profile.id).fingerprint.language).toBe('en-US')
    expect(profiles.get(profile.id).fingerprint.timezone).toBe('America/New_York')
    expect(repaired.report.identityHealth?.score).toBe(100)
    expect(repaired.report.identityHealth?.risk).toBe('low')
    expect(repaired.report.identityDrift?.driftDetected).toBe(false)
    expect(repaired.report.identityBaseline?.version).toBe(2)
    expect(repaired.report.identityBaseline?.status).toBe('active')

    const current = await baselines.get(profile.id)
    const history = await baselines.history(profile.id)
    expect(current?.version).toBe(2)
    expect(history).toHaveLength(1)
    expect(history[0]?.version).toBe(1)
    expect(history[0]?.status).toBe('replaced')
  })
})
