import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { ProfileStore } from './profile-store'
import { publicProfile } from './profile-secrets'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function store(): Promise<ProfileStore> {
  const path = await mkdtemp(join(tmpdir(), 'prism-browser-'))
  temporaryPaths.push(path)
  const result = new ProfileStore(path)
  await result.initialize()
  return result
}

describe('ProfileStore', () => {
  it('persists profiles and creates an independent data directory', async () => {
    const repository = await store()
    const profile = await repository.create(defaultProfileDraft())

    expect(repository.list()).toHaveLength(1)
    const persisted = JSON.parse(await readFile(repository.profilesPath, 'utf8'))
    const owner = JSON.parse(await readFile(repository.profileOwnerPath(profile.id), 'utf8'))
    expect(persisted.profiles[0].id).toBe(profile.id)
    expect(profile.serialNumber).toBe(1)
    expect(persisted.nextSerialNumber).toBe(2)
    expect(owner).toEqual({ schemaVersion: 1, profileId: profile.id })
    expect(repository.profileDataPath(profile.id)).toContain(profile.id)
  })

  it('refuses data access when a profile directory belongs to another environment', async () => {
    const repository = await store()
    const [first, second] = await repository.createMany([defaultProfileDraft(), defaultProfileDraft()])
    await writeFile(repository.profileOwnerPath(first.id), JSON.stringify({
      schemaVersion: 1,
      profileId: second.id
    }))

    await expect(repository.assertProfileDataIdentity(first.id)).rejects.toThrow('环境 ID 不匹配')
    await expect(repository.remove(first.id)).rejects.toThrow('环境 ID 不匹配')
    expect(repository.list()).toHaveLength(2)
  })

  it('duplicates metadata with a new id and fingerprint seed', async () => {
    const repository = await store()
    const original = await repository.create(defaultProfileDraft())
    const copy = await repository.duplicate(original.id)

    expect(copy.id).not.toBe(original.id)
    expect(copy.serialNumber).toBe(original.serialNumber + 1)
    expect(copy.fingerprint.seed).not.toBe(original.fingerprint.seed)
    expect(copy.fingerprint.renderIdentityVersion).toBe(4)
    expect(copy.fingerprint.gpuBucket).toBeTypeOf('number')
    expect(repository.list()).toHaveLength(2)
  })

  it('validates an entire batch before creating any environment', async () => {
    const repository = await store()
    const valid = defaultProfileDraft()
    valid.name = '有效环境'
    const invalid = defaultProfileDraft()
    invalid.name = ''

    await expect(repository.createMany([valid, invalid])).rejects.toThrow('环境名称')
    expect(repository.list()).toHaveLength(0)
  })

  it('creates a validated batch with independent ids and data directories', async () => {
    const repository = await store()
    const first = defaultProfileDraft()
    const second = defaultProfileDraft()
    first.name = '批量 1'
    second.name = '批量 2'

    const created = await repository.createMany([first, second])
    expect(created).toHaveLength(2)
    expect(created[0].id).not.toBe(created[1].id)
    expect(created.map((profile) => profile.serialNumber)).toEqual([1, 2])
    expect(repository.profileDataPath(created[0].id)).not.toBe(repository.profileDataPath(created[1].id))
    expect(repository.list()).toHaveLength(2)
  })

  it('never reuses a permanent environment number after deletion and restart', async () => {
    const repository = await store()
    const first = await repository.create(defaultProfileDraft())
    await repository.remove(first.id)

    const reopened = new ProfileStore(repository.vaultPath)
    await reopened.initialize()
    const second = await reopened.create(defaultProfileDraft())

    expect(first.serialNumber).toBe(1)
    expect(second.serialNumber).toBe(2)
  })

  it('updates group and appends deduplicated tags for a selected batch', async () => {
    const repository = await store()
    const firstDraft = defaultProfileDraft()
    firstDraft.name = '环境 A'
    firstDraft.tags = ['已有']
    const secondDraft = defaultProfileDraft()
    secondDraft.name = '环境 B'
    const [first, second] = await repository.createMany([firstDraft, secondDraft])

    const changed = await repository.classifyMany([first.id, second.id], {
      group: '新分组',
      addTags: ['已有', '批量标签']
    })

    expect(changed).toHaveLength(2)
    expect(repository.get(first.id).group).toBe('新分组')
    expect(repository.get(first.id).tags).toEqual(['已有', '批量标签'])
    expect(repository.get(second.id).tags).toEqual(['已有', '批量标签'])
  })

  it('persists favorite state without changing the fingerprint seed', async () => {
    const repository = await store()
    const profile = await repository.create(defaultProfileDraft())

    await repository.setFavorite(profile.id, true)
    const reopened = new ProfileStore(repository.vaultPath)
    await reopened.initialize()

    expect(reopened.get(profile.id).favorite).toBe(true)
    expect(reopened.get(profile.id).fingerprint.seed).toBe(profile.fingerprint.seed)
  })


  it('defaults new environments to account mode and prevents two account profiles from sharing a proxy identity', async () => {
    const repository = await store()
    const firstDraft = defaultProfileDraft()
    firstDraft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'account-a', password: 'one' }
    const first = await repository.create(firstDraft)
    expect(first.environmentType).toBe('account')

    const secondDraft = defaultProfileDraft()
    secondDraft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'account-a', password: 'two' }
    await expect(repository.create(secondDraft)).rejects.toThrow('一号一代理')

    secondDraft.environmentType = 'temporary'
    await expect(repository.create(secondDraft)).resolves.toMatchObject({ environmentType: 'temporary' })
  })

  it('blocks account environments that resolve to an exit IP already used by another account environment', async () => {
    const repository = await store()
    const firstDraft = defaultProfileDraft()
    firstDraft.proxy = { protocol: 'http', host: 'one.example.com', port: 8080, username: 'a', password: 'one' }
    const secondDraft = defaultProfileDraft()
    secondDraft.proxy = { protocol: 'http', host: 'two.example.com', port: 8080, username: 'b', password: 'two' }
    const first = await repository.create(firstDraft)
    const second = await repository.create(secondDraft)
    const checkedAt = new Date().toISOString()
    await repository.setProxyCheck(first.id, { ok: true, ip: '203.0.113.44', latencyMs: 30, checkedAt })
    await expect(repository.setProxyCheck(second.id, {
      ok: true,
      ip: '203.0.113.44',
      latencyMs: 40,
      checkedAt
    })).rejects.toThrow('实际出口 IP')
  })

  it('keeps a proxy-pool binding when an account profile is edited without retyping the stored password', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'secret' }
    const created = await repository.create(draft)
    await repository.assignProxy(created.id, draft.proxy, {
      ok: true,
      ip: '203.0.113.55',
      latencyMs: 50,
      checkedAt: new Date().toISOString(),
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      latitude: 34.05,
      longitude: -118.24,
      geoConfidence: 'consensus'
    }, '11111111-1111-1111-1111-111111111111')
    const publicDraft = publicProfile(repository.get(created.id))
    publicDraft.name = 'renamed'
    await repository.update(created.id, publicDraft)
    expect(repository.get(created.id).proxyPoolEntryId).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('preserves, replaces or clears a stored proxy password without exposing a marker on disk', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'secret' }
    const created = await repository.create(draft)

    const unchanged = publicProfile(created)
    await repository.update(created.id, unchanged)
    expect(repository.get(created.id).proxy.password).toBe('secret')

    const replaced = publicProfile(repository.get(created.id))
    await repository.update(created.id, { ...replaced, proxy: { ...replaced.proxy, password: 'new-secret' } })
    expect(repository.get(created.id).proxy.password).toBe('new-secret')

    const cleared = publicProfile(repository.get(created.id))
    cleared.proxy.passwordStored = false
    await repository.update(created.id, cleared)
    expect(repository.get(created.id).proxy.password).toBe('')
    expect(await readFile(repository.profilesPath, 'utf8')).not.toContain('passwordStored')
  })

  it('does not carry a saved password to a changed proxy identity', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: 'one.example.com', port: 8080, username: 'user', password: 'secret' }
    const created = await repository.create(draft)
    const changed = publicProfile(created)
    changed.proxy.host = 'two.example.com'

    await repository.update(created.id, changed)
    expect(repository.get(created.id).proxy.password).toBe('')
  })

  it('moves removed profile data to a recoverable recycle directory and restores it', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.group = '店铺组'
    draft.tags = ['重点']
    draft.extensionIds = ['11111111-1111-1111-1111-111111111111']
    const profile = await repository.create(draft)
    expect(await repository.usesExtension(draft.extensionIds[0])).toBe(true)
    await writeFile(join(repository.profileDataPath(profile.id), 'cookie-test'), 'preserved')
    await repository.remove(profile.id)

    expect(repository.list()).toHaveLength(0)
    await expect(readFile(repository.profilesPath, 'utf8')).resolves.toContain('"profiles": []')
    const trash = await repository.listTrash()
    expect(trash).toHaveLength(1)
    expect(trash[0].name).toBe(profile.name)
    expect(await repository.usesExtension(draft.extensionIds[0])).toBe(true)

    const restored = await repository.restore(trash[0].trashId)
    expect(restored.id).toBe(profile.id)
    expect(restored.serialNumber).toBe(profile.serialNumber)
    expect(restored.group).toBe('店铺组')
    expect(restored.tags).toEqual(['重点'])
    await expect(readFile(join(repository.profileDataPath(restored.id), 'cookie-test'), 'utf8')).resolves.toBe('preserved')
    expect(await repository.listTrash()).toHaveLength(0)
  })

  it('tracks pinned kernel references by family in active and recyclable profiles', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.name = '固定内核环境'
    draft.kernelVersion = '144.0.7559.132'
    draft.kernelFamily = 'fingerprint-chromium'
    const profile = await repository.create(draft)

    expect(await repository.kernelUsers(draft.kernelVersion)).toEqual(['固定内核环境'])
    expect(await repository.kernelUsers(draft.kernelVersion, 'fingerprint-chromium')).toEqual(['固定内核环境'])
    expect(await repository.kernelUsers(draft.kernelVersion, 'custom')).toEqual([])

    await repository.remove(profile.id)
    expect(await repository.kernelUsers(draft.kernelVersion, 'fingerprint-chromium')).toEqual(['固定内核环境'])
    expect(await repository.kernelUsers(draft.kernelVersion, 'custom')).toEqual([])
  })

  it('conservatively treats legacy version-only pins as users of either family', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.name = '旧版固定环境'
    draft.kernelVersion = '144.0.7559.132'
    const profile = await repository.create(draft)

    expect(await repository.kernelUsers(draft.kernelVersion, 'fingerprint-chromium')).toEqual(['旧版固定环境'])
    expect(await repository.kernelUsers(draft.kernelVersion, 'custom')).toEqual(['旧版固定环境'])

    await repository.remove(profile.id)
    expect(await repository.kernelUsers(draft.kernelVersion, 'fingerprint-chromium')).toEqual(['旧版固定环境'])
    expect(await repository.kernelUsers(draft.kernelVersion, 'custom')).toEqual(['旧版固定环境'])
  })

  it('advances the automatic kernel floor only within the same family and major', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.name = '补丁升级环境'
    draft.kernelVersion = '144.0.7559.132'
    draft.kernelFamily = 'fingerprint-chromium'
    const profile = await repository.create(draft)

    await expect(repository.advanceKernelFloor(profile.id, '144.0.7559.150', 'fingerprint-chromium'))
      .resolves.toMatchObject({ kernelVersion: '144.0.7559.150' })
    await expect(repository.advanceKernelFloor(profile.id, '144.0.7559.149', 'fingerprint-chromium'))
      .rejects.toThrow('低于环境版本下限')
    await expect(repository.advanceKernelFloor(profile.id, '145.0.1.1', 'fingerprint-chromium'))
      .rejects.toThrow('不能跨主版本')
    await expect(repository.advanceKernelFloor(profile.id, '144.0.7559.160', 'custom'))
      .rejects.toThrow('与环境固定系列')
    expect(repository.get(profile.id).kernelVersion).toBe('144.0.7559.150')
  })

  it('allows pinned kernel upgrades but blocks downgrades for an existing profile', async () => {
    const repository = await store()
    const original = defaultProfileDraft()
    original.kernelVersion = '144.0.7559.132'
    const profile = await repository.create(original)

    const upgraded = defaultProfileDraft()
    upgraded.name = profile.name
    upgraded.kernelVersion = '148.0.7778.215'
    await expect(repository.update(profile.id, upgraded)).resolves.toMatchObject({ kernelVersion: '148.0.7778.215' })

    const downgraded = defaultProfileDraft()
    downgraded.name = profile.name
    downgraded.kernelVersion = '144.0.7559.132'
    await expect(repository.update(profile.id, downgraded)).rejects.toThrow('已阻止内核从 148.0.7778.215 降级到 144.0.7559.132')
    expect(repository.get(profile.id).kernelVersion).toBe('148.0.7778.215')
  })

  it('permanently purges only validated recycle entries', async () => {
    const repository = await store()
    const profile = await repository.create(defaultProfileDraft())
    await writeFile(join(repository.profileDataPath(profile.id), 'site-data'), 'preserved until purge')
    await repository.remove(profile.id)
    const [item] = await repository.listTrash()
    expect(item.sizeBytes).toBeGreaterThan(0)

    await repository.purgeTrash(item.trashId)

    expect(await repository.listTrash()).toEqual([])
    await expect(repository.restore(item.trashId)).rejects.toThrow('不完整')
  })

  it('migrates existing schema 1 profiles with empty groups, tags and extensions', async () => {
    const path = await mkdtemp(join(tmpdir(), 'prism-browser-'))
    temporaryPaths.push(path)
    const draft = defaultProfileDraft() as unknown as Record<string, unknown>
    delete draft.group
    delete draft.tags
    delete draft.extensionIds
    delete draft.kernelVersion
    delete (draft.fingerprint as Record<string, unknown>).hardwareProfileId
    delete (draft.fingerprint as Record<string, unknown>).networkIdentityMode
    delete (draft.fingerprint as Record<string, unknown>).proxyExitPolicy
    await writeFile(join(path, 'profiles.json'), JSON.stringify({
      schemaVersion: 1,
      profiles: [{
        ...draft,
        id: 'legacy-profile',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        status: 'closed'
      }]
    }))

    const repository = new ProfileStore(path)
    await repository.initialize()

    expect(repository.get('legacy-profile').group).toBe('')
    expect(repository.get('legacy-profile').serialNumber).toBe(1)
    expect(repository.get('legacy-profile').tags).toEqual([])
    expect(repository.get('legacy-profile').extensionIds).toEqual([])
    expect(repository.get('legacy-profile').fingerprint.webrtcPolicy).toBe('proxy_only')
    expect(repository.get('legacy-profile').window.mode).toBe('auto')
    expect(repository.get('legacy-profile').favorite).toBe(false)
    expect(repository.get('legacy-profile').kernelVersion).toBe('')
    expect(repository.get('legacy-profile').fingerprint.hardwareProfileId).toBe('legacy-custom')
    expect(repository.get('legacy-profile').fingerprint.networkIdentityMode).toBe('manual')
    expect(repository.get('legacy-profile').fingerprint.proxyExitPolicy).toBe('warn')
    expect(JSON.parse(await readFile(repository.profileOwnerPath('legacy-profile'), 'utf8'))).toEqual({
      schemaVersion: 1,
      profileId: 'legacy-profile'
    })
    const migrated = JSON.parse(await readFile(repository.profilesPath, 'utf8'))
    expect(migrated.schemaVersion).toBe(11)
    expect(migrated.nextSerialNumber).toBe(2)
  })

  it('repairs an invalid WebRTC policy to the safe default', async () => {
    const path = await mkdtemp(join(tmpdir(), 'prism-browser-'))
    temporaryPaths.push(path)
    const draft = defaultProfileDraft()
    draft.fingerprint.webrtcPolicy = 'invalid' as typeof draft.fingerprint.webrtcPolicy
    await writeFile(join(path, 'profiles.json'), JSON.stringify({
      schemaVersion: 4,
      profiles: [{ ...draft, id: 'damaged-profile', createdAt: '', updatedAt: '', status: 'closed' }]
    }))

    const repository = new ProfileStore(path)
    await repository.initialize()

    expect(repository.get('damaged-profile').fingerprint.webrtcPolicy).toBe('proxy_only')
  })

  it('recovers a corrupted primary file from the latest backup and isolates it', async () => {
    const repository = await store()
    const profile = await repository.create(defaultProfileDraft())
    await writeFile(repository.profilesPath, '{broken json', 'utf8')

    const recovered = new ProfileStore(repository.vaultPath)
    await recovered.initialize()

    expect(recovered.get(profile.id).name).toBe(profile.name)
    expect(recovered.storageHealth().recoveredFromBackup).toBe(true)
    expect(recovered.storageHealth().corruptFilePath).toContain('profiles.corrupt-')
    await expect(readFile(recovered.storageHealth().corruptFilePath!, 'utf8')).resolves.toBe('{broken json')
  })

  it('recovers when the primary file is missing but a backup exists', async () => {
    const repository = await store()
    const profile = await repository.create(defaultProfileDraft())
    await rm(repository.profilesPath)

    const recovered = new ProfileStore(repository.vaultPath)
    await recovered.initialize()

    expect(recovered.get(profile.id).id).toBe(profile.id)
    expect(recovered.storageHealth().recoveredFromBackup).toBe(true)
    expect(recovered.storageHealth().corruptFilePath).toBeUndefined()
  })

  it('uses the previous backup when the primary and latest backup are invalid', async () => {
    const repository = await store()
    await repository.create(defaultProfileDraft())
    await writeFile(repository.profilesPath, '{}', 'utf8')
    await writeFile(repository.backupPath, '[]', 'utf8')

    const recovered = new ProfileStore(repository.vaultPath)
    await recovered.initialize()

    expect(recovered.storageHealth().recoveryMessage).toContain('上一份备份')
    expect(JSON.parse(await readFile(recovered.previousBackupPath, 'utf8')).schemaVersion).toBe(11)
  })

  it('refuses to replace data when the primary and both backups are invalid', async () => {
    const repository = await store()
    await repository.create(defaultProfileDraft())
    await writeFile(repository.profilesPath, '{bad primary', 'utf8')
    await writeFile(repository.backupPath, '{bad backup', 'utf8')
    await writeFile(repository.previousBackupPath, '{bad previous', 'utf8')

    const failed = new ProfileStore(repository.vaultPath)
    await expect(failed.initialize()).rejects.toThrow('元数据及备份均无法读取')
    await expect(readFile(repository.profilesPath, 'utf8')).resolves.toBe('{bad primary')
  })

  it('persists the latest proxy check and clears it when proxy credentials change', async () => {
    const repository = await store()
    const draft = defaultProfileDraft()
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'secret' }
    const profile = await repository.create(draft)
    await repository.setProxyCheck(profile.id, {
      ok: true,
      ip: '203.0.113.8',
      latencyMs: 81,
      country: 'United States',
      checkedAt: '2026-08-02T12:00:00.000Z'
    })

    const reopened = new ProfileStore(repository.vaultPath)
    await reopened.initialize()
    expect(reopened.get(profile.id).proxyCheck?.ip).toBe('203.0.113.8')

    const changed = publicProfile(reopened.get(profile.id))
    await reopened.update(profile.id, { ...changed, proxy: { ...changed.proxy, password: 'replacement' } })
    expect(reopened.get(profile.id).proxyCheck).toBeUndefined()
  })

  it('marks a changed proxy exit until the same exit is confirmed again', async () => {
    const repository = await store()
    const profile = await repository.create(defaultProfileDraft())
    const checkedAt = '2026-08-02T12:00:00.000Z'
    await repository.setProxyCheck(profile.id, { ok: true, ip: '203.0.113.8', latencyMs: 10, checkedAt })
    const changed = await repository.setProxyCheck(profile.id, { ok: true, ip: '203.0.113.9', latencyMs: 11, checkedAt })
    expect(changed.proxyCheck).toMatchObject({ exitChanged: true, previousIp: '203.0.113.8' })

    const confirmed = await repository.setProxyCheck(profile.id, { ok: true, ip: '203.0.113.9', latencyMs: 9, checkedAt })
    expect(confirmed.proxyCheck?.exitChanged).toBe(false)
    expect(confirmed.proxyCheck?.previousIp).toBeUndefined()
  })
})
