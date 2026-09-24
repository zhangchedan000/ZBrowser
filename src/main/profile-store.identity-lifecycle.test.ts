import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { emptyIdentityConfigProvenance } from '../shared/identity-config-provenance'
import type { IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import { IdentityBaselineStore } from './identity-baseline-store'
import { requestBaselineReplacementForChange } from './identity-baseline-lifecycle'
import { ProfileStore } from './profile-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function snapshot(): IdentityBaselineSnapshot {
  return {
    browser: { userAgent: 'Chrome/144.0.7559.132', platform: 'Win32' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 },
    gpu: { webgl: { unmaskedVendor: 'NVIDIA Corporation', unmaskedRenderer: 'NVIDIA GeForce RTX 4060' } },
    rendering: { fonts: { detected: ['Segoe UI'] } },
    network: { ip: '203.0.113.10', countryCode: 'US', timezone: 'America/New_York' },
    locale: { language: 'en-US', timezone: 'America/New_York' }
  }
}

async function harness() {
  const vault = await mkdtemp(join(tmpdir(), 'zbrowser-profile-lifecycle-'))
  temporaryPaths.push(vault)
  const baselines = new IdentityBaselineStore(vault)
  const profiles = new ProfileStore(vault, undefined, async (before, after, reason) => {
    await requestBaselineReplacementForChange(baselines, before, after, reason)
  })
  await profiles.initialize()

  const draft = defaultProfileDraft()
  draft.kernelVersion = '144.0.7559.132'
  draft.kernelFamily = 'fingerprint-chromium'
  const profile = await profiles.create(draft)
  await baselines.create(
    profile.id,
    snapshot(),
    profile.identityConfigProvenance ?? emptyIdentityConfigProvenance()
  )
  return { baselines, profiles, profile }
}

describe('profile identity baseline lifecycle wiring', () => {
  it('ignores metadata-only edits and requests replacement for identity config edits', async () => {
    const { baselines, profiles, profile } = await harness()

    const renamed = profiles.get(profile.id)
    await profiles.update(profile.id, { ...renamed, name: 'Renamed only' })
    expect(await baselines.pendingReplacement(profile.id)).toBeNull()
    expect((await baselines.get(profile.id))?.status).toBe('active')

    const current = profiles.get(profile.id)
    await profiles.update(profile.id, {
      ...current,
      fingerprint: { ...current.fingerprint, language: 'ja-JP' }
    })

    expect((await baselines.pendingReplacement(profile.id))?.reasons).toEqual(['user_config'])
    expect((await baselines.get(profile.id))?.status).toBe('stale')
  })

  it('records kernel upgrade and rollback reasons', async () => {
    const { baselines, profiles, profile } = await harness()

    await profiles.advanceKernelFloor(profile.id, '144.0.7559.133', 'fingerprint-chromium')
    expect((await baselines.pendingReplacement(profile.id))?.reasons).toEqual(['kernel_upgrade'])

    const upgraded = profiles.get(profile.id)
    await baselines.create(
      profile.id,
      snapshot(),
      upgraded.identityConfigProvenance ?? emptyIdentityConfigProvenance()
    )
    await profiles.restoreKernelBinding(profile.id, '144.0.7559.132', 'fingerprint-chromium')
    expect((await baselines.pendingReplacement(profile.id))?.reasons).toEqual(['kernel_rollback'])
  })

  it('rolls profile data back on disk when the lifecycle hook fails', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-profile-lifecycle-rollback-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault, undefined, async () => {
      throw new Error('baseline write failed')
    })
    await profiles.initialize()

    const draft = defaultProfileDraft()
    const profile = await profiles.create(draft)
    const originalLanguage = profile.fingerprint.language

    await expect(profiles.update(profile.id, {
      ...profile,
      fingerprint: { ...profile.fingerprint, language: 'ja-JP' }
    })).rejects.toThrow('baseline write failed')
    expect(profiles.get(profile.id).fingerprint.language).toBe(originalLanguage)

    const reloaded = new ProfileStore(vault)
    await reloaded.initialize()
    expect(reloaded.get(profile.id).fingerprint.language).toBe(originalLanguage)
  })

  it('records proxy reassignment after a validated assignment', async () => {
    const { baselines, profiles, profile } = await harness()

    await profiles.assignProxy(
      profile.id,
      { protocol: 'http', host: '127.0.0.1', port: 8080, username: '', password: '' },
      {
        ok: true,
        ip: '203.0.113.20',
        latencyMs: 12,
        country: 'United States',
        countryCode: 'US',
        latitude: 40.7128,
        longitude: -74.006,
        timezone: 'America/New_York',
        geoConfidence: 'consensus',
        checkedAt: new Date().toISOString()
      }
    )

    expect((await baselines.pendingReplacement(profile.id))?.reasons).toEqual(['proxy_reassignment'])
    expect((await baselines.get(profile.id))?.status).toBe('stale')
  })
})
