import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { emptyIdentityConfigProvenance, markFingerprintConfigSources } from '../shared/identity-config-provenance'
import { ProfileStore } from './profile-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ProfileStore identity provenance', () => {
  it('persists AI and user field sources across a store restart', async () => {
    const path = await mkdtemp(join(tmpdir(), 'zbrowser-provenance-'))
    temporaryPaths.push(path)
    const repository = new ProfileStore(path)
    await repository.initialize()

    const draft = defaultProfileDraft()
    let provenance = emptyIdentityConfigProvenance()
    provenance = markFingerprintConfigSources(provenance, ['timezone'], 'user')
    provenance = markFingerprintConfigSources(provenance, ['language', 'webrtcPolicy'], 'ai')
    draft.identityConfigProvenance = provenance

    const created = await repository.create(draft)
    const reopened = new ProfileStore(path)
    await reopened.initialize()
    const restored = reopened.get(created.id)
    const persisted = JSON.parse(await readFile(reopened.profilesPath, 'utf8'))

    expect(persisted.schemaVersion).toBe(13)
    expect(restored.identityConfigProvenance?.locale.timezone).toBe('user')
    expect(restored.identityConfigProvenance?.locale.language).toBe('ai')
    expect(restored.identityConfigProvenance?.network.webrtcPolicy).toBe('ai')
  })

  it('normalizes legacy profiles without provenance to default sources', async () => {
    const draft = defaultProfileDraft()
    delete draft.identityConfigProvenance
    const path = await mkdtemp(join(tmpdir(), 'zbrowser-provenance-'))
    temporaryPaths.push(path)
    const repository = new ProfileStore(path)
    await repository.initialize()

    const created = await repository.create(draft)

    expect(created.identityConfigProvenance).toEqual(emptyIdentityConfigProvenance())
  })
})
