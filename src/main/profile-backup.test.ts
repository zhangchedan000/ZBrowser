import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import { ProfileBackupManager } from './profile-backup'
import { ProfileStore } from './profile-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ProfileBackupManager', () => {
  it('exports a password-free manifest and imports browser data as a new environment', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-backup-vault-'))
    const destination = await mkdtemp(join(tmpdir(), 'prism-backup-output-'))
    temporaryPaths.push(vault, destination)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.name = '迁移环境'
    draft.extensionIds = ['11111111-1111-1111-1111-111111111111']
    draft.proxy = { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'secret-password' }
    const source = await profiles.create(draft)
    const sourceData = profiles.profileDataPath(source.id)
    const browserData = new Map([
      ['Default/Cookies.test', 'session-data'],
      ['Default/Local Storage/leveldb/000003.log', 'local-storage'],
      ['Default/IndexedDB/http_localhost_0.indexeddb.leveldb/000003.log', 'indexed-db'],
      ['Default/Service Worker/CacheStorage/cache-entry', 'cache-storage'],
      ['Default/Service Worker/Database/000003.log', 'service-worker'],
      ['Default/File System/Origins/000003.log', 'origin-file-system']
    ])
    for (const [relativePath, content] of browserData) {
      const path = join(sourceData, relativePath)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
    const manager = new ProfileBackupManager(profiles, '0.1.0')

    const exported = await manager.export(source.id, destination)
    const manifestText = await readFile(join(exported.path, 'manifest.json'), 'utf8')
    expect(manifestText).not.toContain('secret-password')
    expect(JSON.parse(manifestText).profile.extensionIds).toEqual([])
    expect(JSON.parse(manifestText).contentSha256).toMatch(/^[a-f\d]{64}$/)

    const imported = await manager.import(exported.path)
    expect(imported.profile.id).not.toBe(source.id)
    expect(imported.profile.name).toContain('迁移')
    expect(imported.profile.proxy.password).toBe('')
    expect(imported.profile.extensionIds).toEqual([])
    for (const [relativePath, content] of browserData) {
      await expect(readFile(join(profiles.profileDataPath(imported.profile.id), relativePath), 'utf8')).resolves.toBe(content)
    }
    expect(await readdir(exported.path)).not.toContain('profile-owner.json')
    expect(JSON.parse(await readFile(profiles.profileOwnerPath(imported.profile.id), 'utf8')).profileId).toBe(imported.profile.id)

    const profileCount = profiles.list().length
    await writeFile(join(exported.path, 'user-data', 'Default', 'Cookies.test'), 'changed-data')
    await expect(manager.import(exported.path)).rejects.toThrow('SHA-256')
    expect(profiles.list()).toHaveLength(profileCount)
    expect(await profiles.listTrash()).toHaveLength(0)
    expect((await readdir(vault)).filter((name) => name.startsWith('.profile-backup-import-'))).toEqual([])
  })

  it('creates a pre-upgrade checkpoint and restores data plus the previous kernel binding', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-upgrade-backup-vault-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.name = '升级回滚环境'
    draft.kernelVersion = '144.0.7559.132'
    draft.kernelFamily = 'fingerprint-chromium'
    const source = await profiles.create(draft)
    const marker = join(profiles.profileDataPath(source.id), 'Default', 'upgrade-marker.txt')
    const disposableCache = join(profiles.profileDataPath(source.id), 'Default', 'Cache', 'cache-entry')
    await mkdir(join(marker, '..'), { recursive: true })
    await mkdir(join(disposableCache, '..'), { recursive: true })
    await writeFile(marker, 'before-upgrade')
    await writeFile(disposableCache, 'throw-away-cache')

    const manager = new ProfileBackupManager(profiles, '0.1.0')
    const checkpoint = await manager.createKernelUpgradeCheckpoint(source.id, '148.0.7778.215', 'fingerprint-chromium')
    expect(checkpoint).toMatchObject({
      fromVersion: '144.0.7559.132',
      fromFamily: 'fingerprint-chromium',
      toVersion: '148.0.7778.215',
      toFamily: 'fingerprint-chromium'
    })

    const upgradedDraft = defaultProfileDraft()
    upgradedDraft.name = source.name
    upgradedDraft.kernelVersion = '148.0.7778.215'
    upgradedDraft.kernelFamily = 'fingerprint-chromium'
    await profiles.update(source.id, upgradedDraft)
    await profiles.advanceKernelFloor(source.id, '148.0.7778.220', 'fingerprint-chromium')
    await writeFile(marker, 'after-upgrade')

    const restored = await manager.rollbackKernelUpgrade(source.id)
    expect(restored.kernelVersion).toBe('144.0.7559.132')
    expect(restored.kernelFamily).toBe('fingerprint-chromium')
    await expect(readFile(marker, 'utf8')).resolves.toBe('before-upgrade')
    await expect(readFile(disposableCache, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.kernelUpgradeCheckpoint(source.id)).resolves.toBeNull()
  })

  it('keeps only the latest upgrade checkpoint and removes it after seven days of healthy use', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-upgrade-retention-vault-'))
    temporaryPaths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.name = '升级备份保留环境'
    draft.kernelVersion = '144.0.7559.132'
    draft.kernelFamily = 'fingerprint-chromium'
    const source = await profiles.create(draft)
    const manager = new ProfileBackupManager(profiles, '0.1.0')

    await manager.createKernelUpgradeCheckpoint(source.id, '148.0.7778.215', 'fingerprint-chromium')
    await profiles.update(source.id, {
      ...draft,
      name: source.name,
      kernelVersion: '148.0.7778.215',
      kernelFamily: 'fingerprint-chromium'
    })
    await manager.createKernelUpgradeCheckpoint(source.id, '149.0.0.1', 'fingerprint-chromium')

    const root = join(vault, 'kernel-upgrade-backups', source.id)
    const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    expect(directories).toHaveLength(1)

    await profiles.update(source.id, {
      ...draft,
      name: source.name,
      kernelVersion: '149.0.0.1',
      kernelFamily: 'fingerprint-chromium'
    })
    await expect(manager.noteKernelUpgradeHealthyLaunch(source.id)).resolves.toBe('marked')

    const recordPath = join(root, 'latest.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    record.healthySince = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    await writeFile(recordPath, JSON.stringify(record, null, 2))

    await expect(manager.noteKernelUpgradeHealthyLaunch(source.id)).resolves.toBe('cleaned')
    await expect(manager.kernelUpgradeCheckpoint(source.id)).resolves.toBeNull()
  })

  it('rejects unsafe manifest limits before creating an imported environment', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'prism-backup-vault-'))
    const source = await mkdtemp(join(tmpdir(), 'prism-backup-input-'))
    temporaryPaths.push(vault, source)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    await mkdir(join(source, 'user-data'))
    await writeFile(join(source, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sourcePlatform: process.platform,
      sourceAppVersion: '0.1.0',
      totalBytes: Number.MAX_SAFE_INTEGER,
      fileCount: 0,
      profile: defaultProfileDraft()
    }))

    const manager = new ProfileBackupManager(profiles, '0.1.0')
    await expect(manager.import(source)).rejects.toThrow('超出安全范围')
    expect(profiles.list()).toHaveLength(0)
  })
})
