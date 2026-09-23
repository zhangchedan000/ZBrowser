import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from '../shared/identity-config-provenance'
import type { AIIdentityGenerationResult } from '../shared/identity-ai-generator'
import type { FingerprintRuntimeDiagnosticReport } from '../shared/types'
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
      fingerprint: {
        hardwareConcurrency: { value: 4, source: 'ai' },
        screenWidth: { value: 1920, source: 'ai' },
        screenHeight: { value: 1080, source: 'ai' }
      },
      network: {
        networkIdentityMode: { value: 'manual', source: 'ai' }
      },
      locale: {
        language: { value: 'en-US', source: 'ai' },
        acceptLanguages: { value: 'en-US,en', source: 'ai' },
        timezone: { value: 'America/New_York', source: 'ai' }
      },
      browser: {}
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
    draft.fingerprint.hardwareConcurrency = 12
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

    const result = await executor.execute(profile.id, true)
    const saved = profiles.get(profile.id)
    const history = await state.history(profile.id)

    expect(result.status).toBe('completed')
    expect(verifiedProfileId).toBe(profile.id)
    expect(saved.fingerprint.hardwareConcurrency).toBe(4)
    expect(saved.fingerprint.language).toBe('en-US')
    expect(saved.fingerprint.timezone).toBe('America/Los_Angeles')
    expect(saved.identityConfigProvenance?.locale.timezone).toBe('user')
    expect(saved.identityConfigProvenance?.fingerprint.hardwareConcurrency).toBe('ai')
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
    draft.fingerprint.hardwareConcurrency = 16
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

    const result = await executor.execute(profile.id, true)
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

    await expect(executor.execute(profile.id, false)).rejects.toThrow('明确确认')
    expect(await state.checkpoint(profile.id)).toBeNull()
  })

  it('recovers a persisted repair checkpoint after an interrupted process', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-repair-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.fingerprint.hardwareConcurrency = 12
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
      hardwareConcurrency: 2,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
    await profiles.update(profile.id, changed)
    expect(profiles.get(profile.id).fingerprint.hardwareConcurrency).toBe(2)

    const executor = new FingerprintRepairExecutor(
      profiles,
      { diagnoseFingerprintRuntime: async (id) => readyReport(id, true) },
      state,
      undefined,
      () => generatedIdentity()
    )

    await expect(executor.recoverPendingRepairs()).resolves.toBe(1)
    expect(profiles.get(profile.id).fingerprint.hardwareConcurrency).toBe(12)
    expect(await state.checkpoint(profile.id)).toBeNull()
    expect((await state.history(profile.id)).at(-1)?.phase).toBe('rolled_back')
  })
})
