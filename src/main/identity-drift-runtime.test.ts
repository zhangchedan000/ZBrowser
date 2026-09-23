import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import { emptyIdentityConfigProvenance } from '../shared/identity-config-provenance'
import { IdentityBaselineStore } from './identity-baseline-store'
import { evaluateRuntimeIdentity } from './identity-drift-runtime'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function snapshot(renderer = 'NVIDIA GeForce RTX 4060'): IdentityBaselineSnapshot {
  return {
    browser: { userAgent: 'Chrome/144.0.7559.132', platform: 'Win32' },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 },
    gpu: { webgl: { unmaskedVendor: 'NVIDIA Corporation', unmaskedRenderer: renderer } },
    rendering: { fonts: { detected: ['Consolas', 'Segoe UI'] } },
    network: { ip: '203.0.113.10', countryCode: 'US', timezone: 'America/New_York' },
    locale: { language: 'en-US', timezone: 'America/New_York' }
  }
}

async function store(): Promise<IdentityBaselineStore> {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-identity-drift-'))
  temporaryPaths.push(root)
  return new IdentityBaselineStore(root)
}

describe('runtime identity drift monitoring', () => {
  it('creates the first baseline only when runtime is allowed to establish identity', async () => {
    const repository = await store()
    const blocked = await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot(),
      emptyIdentityConfigProvenance(),
      { allowCreateBaseline: false }
    )

    expect(blocked.baselineCreated).toBe(false)
    expect(blocked.baseline).toBeUndefined()
    expect(await repository.get('profile-1')).toBeNull()

    const created = await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot(),
      emptyIdentityConfigProvenance(),
      { allowCreateBaseline: true }
    )

    expect(created.baselineCreated).toBe(true)
    expect(created.baseline?.status).toBe('active')
    expect(created.drift).toBeUndefined()
  })

  it('keeps a matching baseline active and emits a no-drift report', async () => {
    const repository = await store()
    const first = await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot(),
      emptyIdentityConfigProvenance()
    )
    const checked = await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot(),
      emptyIdentityConfigProvenance()
    )

    expect(checked.baselineCreated).toBe(false)
    expect(checked.baseline?.id).toBe(first.baseline?.id)
    expect(checked.baseline?.status).toBe('active')
    expect(checked.drift?.driftDetected).toBe(false)
    expect(checked.drift?.severity).toBe('low')
  })

  it('marks the persisted baseline stale when a critical GPU drift is observed', async () => {
    const repository = await store()
    await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot(),
      emptyIdentityConfigProvenance()
    )

    const changed = await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot('Google SwiftShader'),
      emptyIdentityConfigProvenance(),
      { allowCreateBaseline: false }
    )

    expect(changed.drift?.driftDetected).toBe(true)
    expect(changed.drift?.severity).toBe('critical')
    expect(changed.baseline?.status).toBe('stale')
    expect((await repository.get('profile-1'))?.status).toBe('stale')
  })

  it('reactivates a stale baseline after the runtime returns to the stored identity', async () => {
    const repository = await store()
    await evaluateRuntimeIdentity(repository, 'profile-1', snapshot(), emptyIdentityConfigProvenance())
    await evaluateRuntimeIdentity(repository, 'profile-1', snapshot('Google SwiftShader'), emptyIdentityConfigProvenance())

    const recovered = await evaluateRuntimeIdentity(
      repository,
      'profile-1',
      snapshot(),
      emptyIdentityConfigProvenance()
    )

    expect(recovered.drift?.driftDetected).toBe(false)
    expect(recovered.baseline?.status).toBe('active')
  })
})
