import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from '../shared/identity-config-provenance'
import type { AIIdentityGenerationResult } from '../shared/identity-ai-generator'
import type { FingerprintRuntimeDiagnosticReport } from '../shared/types'
import type { IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import { IdentityBaselineStore } from './identity-baseline-store'
import { FingerprintRepairExecutor } from './fingerprint-repair-executor'
import { FingerprintRepairStateStore } from './fingerprint-repair-state'
import { ProfileStore } from './profile-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function generatedIdentity(): AIIdentityGenerationResult {
  return {
    config: {
      fingerprint: {},
      network: {
        networkIdentityMode: { value: 'manual', source: 'ai' }
      },
      locale: {
        language: { value: 'en-US', source: 'ai' },
        acceptLanguages: { value: 'en-US,en', source: 'ai' },
        timezone: { value: 'America/New_York', source: 'ai' }
      },
      browser: {
        brand: { value: 'Edge', source: 'ai' },
        brandVersion: { value: '144.0.0.0', source: 'ai' }
      }
    },
    warnings: [],
    networkReadiness: 'manual'
  }
}

function readyReport(profileId: string, ready: boolean): FingerprintRuntimeDiagnosticReport {
  return {
    profileId,
    checkedAt: new Date().toISOString(),
    ready,
    checks: ready
      ? [{ key: 'runtime-timezone', label: 'Timezone', status: 'pass', message: 'matched' }]
      : [{ key: 'runtime-hardware-concurrency', label: 'CPU', status: 'error', message: 'mismatch' }]
  }
}

describe('FingerprintRepairExecutor', () => {
  it('applies AI-owned repair, preserves user overrides, verifies runtime and clears the checkpoint', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()

    const draft = defaultProfileDraft()
    draft.fingerprint.platform = 'windows'
    draft.fingerprint.language = 'de-DE'
    draft.fingerprint.acceptLanguages = 'de-DE,de'
    draft.fingerprint.timezone = 'America/Los_Angeles'
    let provenance = emptyIdentityConfigProvenance()
    provenance = markFingerprintConfigSources(provenance, ['timezone'], 'user')
    draft.identityConfigProvenance = provenance
    const profile = await profiles.create(draft)

    let verifiedProfileId = ''
    const state = new FingerprintRepairStateStore(profiles)
    const executor = new FingerprintRepairExecutor(
      profiles,
      {
        diagnoseFingerprintRuntime: async (id) => {
          verifiedProfileId = id
          return readyReport(id, true)
        }
      },
      state,
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)
    expect(plan.status).toBe('ready')
    expect(plan.sections).toContain('locale')
    expect(plan.sections).toContain('browser')
    expect(plan.changes.some((change) => change.field === 'timezone')).toBe(false)

    const result = await executor.execute(profile.id, true, plan.planId, ['locale'])
    const saved = profiles.get(profile.id)
    const history = await state.history(profile.id)

    expect(result.status).toBe('completed')
    expect(verifiedProfileId).toBe(profile.id)
    expect(saved.fingerprint.language).toBe('en-US')
    expect(saved.fingerprint.brand).toBe('Chrome')
    expect(saved.fingerprint.timezone).toBe('America/Los_Angeles')
    expect(saved.identityConfigProvenance?.locale.timezone).toBe('user')
    expect(saved.identityConfigProvenance?.locale.language).toBe('ai')
    expect(await state.checkpoint(profile.id)).toBeNull()
    expect(history.map((record) => record.phase)).toEqual(['backup', 'applied', 'verified'])
    expect(JSON.stringify(history)).not.toContain('America/Los_Angeles')
  })

  it('rolls back the saved identity config when runtime verification fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()

    const draft = defaultProfileDraft()
    draft.fingerprint.platform = 'windows'
    draft.fingerprint.language = 'fr-FR'
    const profile = await profiles.create(draft)
    const before = JSON.parse(JSON.stringify(profiles.get(profile.id).fingerprint))

    const state = new FingerprintRepairStateStore(profiles)
    const executor = new FingerprintRepairExecutor(
      profiles,
      { diagnoseFingerprintRuntime: async (id) => readyReport(id, false) },
      state,
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)
    const result = await executor.execute(profile.id, true, plan.planId, ['locale'])
    const restored = profiles.get(profile.id)
    const history = await state.history(profile.id)

    expect(result.status).toBe('rolled_back')
    expect(restored.fingerprint).toEqual(before)
    expect(await state.checkpoint(profile.id)).toBeNull()
    expect(history.map((record) => record.phase)).toEqual(['backup', 'applied', 'rolled_back'])
  })

  it('refuses execution without explicit user approval', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const profile = await profiles.create(defaultProfileDraft())
    const state = new FingerprintRepairStateStore(profiles)
    const executor = new FingerprintRepairExecutor(
      profiles,
      { diagnoseFingerprintRuntime: async (id) => readyReport(id, true) },
      state,
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)
    await expect(executor.execute(profile.id, false, plan.planId, plan.sections)).rejects.toThrow('明确确认')
    expect(await state.checkpoint(profile.id)).toBeNull()
  })

  it('rejects a stale preview when the profile changes before confirmation', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const profile = await profiles.create(defaultProfileDraft())
    const state = new FingerprintRepairStateStore(profiles)
    const executor = new FingerprintRepairExecutor(
      profiles,
      { diagnoseFingerprintRuntime: async (id) => readyReport(id, true) },
      state,
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)
    const draft = defaultProfileDraft()
    draft.name = profile.name
    draft.note = 'changed after preview'
    draft.group = profile.group
    draft.tags = [...profile.tags]
    draft.extensionIds = [...profile.extensionIds]
    draft.color = profile.color
    draft.startUrls = [...profile.startUrls]
    draft.kernelVersion = profile.kernelVersion
    draft.kernelFamily = profile.kernelFamily
    draft.window = { ...profile.window }
    draft.proxy = { ...profile.proxy }
    draft.environmentType = profile.environmentType
    draft.identityConfigProvenance = profile.identityConfigProvenance
    draft.fingerprint = {
      ...profile.fingerprint,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
    await profiles.update(profile.id, draft)

    await expect(executor.execute(profile.id, true, plan.planId, ['locale']))
      .rejects.toThrow('重新生成 AI 修复计划')
  })

  it('recovers a persisted repair checkpoint after an interrupted process', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.fingerprint.language = 'fr-FR'
    const profile = await profiles.create(draft)

    const state = new FingerprintRepairStateStore(profiles)
    await state.createCheckpoint(profile.id, 'audit-crash', profile.fingerprint, profile.identityConfigProvenance)

    const changed = defaultProfileDraft()
    changed.name = profile.name
    changed.note = profile.note
    changed.group = profile.group
    changed.tags = [...profile.tags]
    changed.extensionIds = [...profile.extensionIds]
    changed.color = profile.color
    changed.startUrls = [...profile.startUrls]
    changed.kernelVersion = profile.kernelVersion
    changed.kernelFamily = profile.kernelFamily
    changed.window = { ...profile.window }
    changed.proxy = { ...profile.proxy }
    changed.environmentType = profile.environmentType
    changed.identityConfigProvenance = profile.identityConfigProvenance
    changed.fingerprint = {
      ...profile.fingerprint,
      language: 'ja-JP',
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
    await profiles.update(profile.id, changed)
    expect(profiles.get(profile.id).fingerprint.language).toBe('ja-JP')

    const executor = new FingerprintRepairExecutor(
      profiles,
      { diagnoseFingerprintRuntime: async (id) => readyReport(id, true) },
      state,
      undefined,
      () => generatedIdentity()
    )

    await expect(executor.recoverPendingRepairs()).resolves.toBe(1)
    expect(profiles.get(profile.id).fingerprint.language).toBe('fr-FR')
    expect(await state.checkpoint(profile.id)).toBeNull()
    expect((await state.history(profile.id)).at(-1)?.phase).toBe('rolled_back')
  })

  it('scopes an AI repair plan to diagnosed actionable fields and excludes unrelated generated changes', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()

    const draft = defaultProfileDraft()
    draft.fingerprint.language = 'de-DE'
    draft.fingerprint.brand = 'Chrome'
    const profile = await profiles.create(draft)
    const state = new FingerprintRepairStateStore(profiles)
    const executor = new FingerprintRepairExecutor(
      profiles,
      {
        diagnoseFingerprintRuntime: async (id) => ({
          profileId: id,
          checkedAt: new Date().toISOString(),
          ready: false,
          identityDiagnosis: {
            summary: 'Fingerprint Health score 75, risk medium',
            risks: ['locale: language drift'],
            suggestedActions: ['检查时区、语言和地区设置一致性'],
            requiresUserConfirmation: true,
            protectedUserOverrides: 0,
            issues: [{
              component: 'locale',
              key: 'identity-drift:locale.language',
              evidence: 'locale.language changed from baseline',
              configReferences: [{ section: 'locale', key: 'language', source: 'ai' }],
              repairPolicy: 'confirm_apply'
            }]
          },
          checks: []
        })
      },
      state,
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)

    expect(plan.status).toBe('ready')
    expect(plan.diagnosedIssueKeys).toEqual(['identity-drift:locale.language'])
    expect(plan.changes.map((change) => change.field)).toEqual(['language'])
    expect(plan.changes.some((change) => change.field === 'brand')).toBe(false)
    expect(plan.diagnosisSummary).toContain('risk medium')
  })

  it('keeps user-owned diagnosis issues suggest-only and out of the executable plan', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()

    const draft = defaultProfileDraft()
    draft.fingerprint.timezone = 'America/Los_Angeles'
    draft.identityConfigProvenance = markFingerprintConfigSources(
      emptyIdentityConfigProvenance(),
      ['timezone'],
      'user'
    )
    const profile = await profiles.create(draft)
    const state = new FingerprintRepairStateStore(profiles)
    const executor = new FingerprintRepairExecutor(
      profiles,
      {
        diagnoseFingerprintRuntime: async (id) => ({
          profileId: id,
          checkedAt: new Date().toISOString(),
          ready: false,
          identityDiagnosis: {
            summary: 'Fingerprint Health score 75, risk medium',
            risks: ['locale: timezone drift'],
            suggestedActions: ['检查时区、语言和地区设置一致性'],
            requiresUserConfirmation: true,
            protectedUserOverrides: 1,
            issues: [{
              component: 'locale',
              key: 'identity-drift:locale.timezone',
              evidence: 'locale.timezone changed from baseline',
              configReferences: [{ section: 'locale', key: 'timezone', source: 'user' }],
              repairPolicy: 'suggest_only'
            }]
          },
          checks: []
        })
      },
      state,
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)

    expect(plan.status).toBe('no_changes')
    expect(plan.protectedUserOverrides).toBe(1)
    expect(plan.warnings.join(' ')).toContain('不会由 AI 覆盖')
    expect(plan.changes).toEqual([])
  })

  it('promotes a verified repaired runtime into the next baseline version', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()

    const draft = defaultProfileDraft()
    draft.fingerprint.language = 'fr-FR'
    const profile = await profiles.create(draft)
    const snapshot = (language: string): IdentityBaselineSnapshot => ({
      browser: { userAgent: 'Chrome/144.0.7559.132', platform: 'Win32' },
      hardware: { hardwareConcurrency: 8, deviceMemory: 8 },
      gpu: { webgl: { unmaskedVendor: 'NVIDIA Corporation', unmaskedRenderer: 'NVIDIA GeForce RTX 4060' } },
      rendering: { fonts: { detected: ['Segoe UI'] } },
      network: { ip: '203.0.113.10', countryCode: 'US' },
      locale: { language, timezone: 'America/New_York' }
    })
    const baselines = new IdentityBaselineStore(profiles.vaultPath)
    const original = await baselines.create(
      profile.id,
      snapshot('fr-FR'),
      emptyIdentityConfigProvenance()
    )

    let calls = 0
    const executor = new FingerprintRepairExecutor(
      profiles,
      {
        diagnoseFingerprintRuntime: async (id) => {
          calls += 1
          if (calls === 1) return readyReport(id, true)
          return {
            ...readyReport(id, true),
            identityCapturedAt: new Date().toISOString(),
            identitySnapshot: snapshot('en-US')
          }
        }
      },
      new FingerprintRepairStateStore(profiles),
      undefined,
      () => generatedIdentity()
    )

    const plan = await executor.plan(profile.id)
    const result = await executor.execute(profile.id, true, plan.planId, ['locale'])
    const current = await baselines.get(profile.id)
    const history = await baselines.history(profile.id)

    expect(result.status).toBe('completed')
    expect(current?.version).toBe(2)
    expect(current?.status).toBe('active')
    expect(current?.id).not.toBe(original.id)
    expect(result.report.identityBaseline?.version).toBe(2)
    expect(result.report.identityDrift?.driftDetected).toBe(false)
    expect(result.report.identityHealth?.score).toBe(100)
    expect(history.at(-1)?.id).toBe(original.id)
    expect(history.at(-1)?.status).toBe('replaced')
  })

})
