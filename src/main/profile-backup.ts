import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { BrowserProfile, KernelFamily, KernelUpgradeCheckpointSummary, ProfileBackupResult, ProfileDraft } from '../shared/types'
import { compareKernelVersions, sameKernelMajor } from '../shared/kernel-version'
import { validateProfileDraft } from '../shared/validation'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'

interface ProfileBackupManifest {
  schemaVersion: 1
  exportedAt: string
  sourcePlatform: NodeJS.Platform
  sourceAppVersion: string
  totalBytes: number
  fileCount: number
  contentSha256?: string
  profile: ProfileDraft
}

interface CopyStats {
  bytes: number
  files: number
  hash: Hash
}

interface KernelUpgradeCheckpointRecord extends KernelUpgradeCheckpointSummary {
  schemaVersion: 1
  profileId: string
  backupDirectory: string
  healthySince?: string
}

const MAX_BACKUP_FILES = 1_000_000
const MAX_BACKUP_BYTES = 500 * 1024 * 1024 * 1024
const KERNEL_UPGRADE_BACKUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
const DISPOSABLE_CACHE_DIRECTORIES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawncache',
  'grshadercache',
  'shadercache',
  'graphitedawncache',
  'media cache'
])

type RenameOperation = (source: string, target: string) => Promise<void>
type WaitOperation = (milliseconds: number) => Promise<void>

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Chromium helper processes and antivirus scanners can briefly keep a closed
 * Windows profile directory locked after the browser process exits. Retrying
 * only known transient lock errors keeps rollback atomic without hiding real
 * path, permission or collision bugs.
 */
export async function renameWithTransientRetry(
  source: string,
  target: string,
  operation: RenameOperation = rename,
  waitOperation: WaitOperation = wait,
  maxAttempts = 8
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT_RENAME_ERRORS.has(code) || attempt >= maxAttempts) throw error
      await waitOperation(Math.min(100 * (2 ** (attempt - 1)), 1000))
    }
  }
}

function safeDirectoryName(name: string): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 50)
  return safe || '环境'
}

function ensureOutside(source: string, target: string): void {
  const normalizedSource = resolve(source)
  const normalizedTarget = resolve(target)
  if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}${sep}`)) {
    throw new Error('备份目录不能位于当前环境数据目录内部')
  }
}

function disposableKernelUpgradeCache(relativePath: string): boolean {
  if (!relativePath) return false
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean).map((part) => part.toLowerCase())
  const leaf = parts.at(-1)
  if (!leaf || !DISPOSABLE_CACHE_DIRECTORIES.has(leaf)) return false
  if (parts.length <= 2) return true
  return parts.length === 3 && parts[parts.length - 2] === 'network' && leaf === 'cache'
}

async function copySafeTree(
  source: string,
  target: string,
  stats: CopyStats,
  relativePath = '',
  skipDirectory: (relativePath: string) => boolean = () => false
): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    if (relativePath && skipDirectory(relativePath)) return
    await mkdir(target, { recursive: true })
    for (const entry of (await readdir(source)).sort()) {
      await copySafeTree(join(source, entry), join(target, entry), stats, join(relativePath, entry), skipDirectory)
    }
    return
  }
  if (!info.isFile()) return
  stats.files += 1
  stats.bytes += info.size
  if (stats.files > MAX_BACKUP_FILES) throw new Error('环境数据文件数量超过 100 万，已停止备份')
  if (stats.bytes > MAX_BACKUP_BYTES) throw new Error('环境数据超过 500 GB，已停止备份')
  await copyFile(source, target)
  stats.hash.update(relativePath.replaceAll(sep, '/'))
  stats.hash.update('\0')
  stats.hash.update(String(info.size))
  stats.hash.update('\0')
  for await (const chunk of createReadStream(target)) stats.hash.update(chunk as Buffer)
}

function portableDraft(profile: BrowserProfile): ProfileDraft {
  return {
    name: profile.name,
    note: profile.note,
    group: profile.group,
    tags: [...profile.tags],
    extensionIds: [],
    color: profile.color,
    startUrls: [...profile.startUrls],
    kernelVersion: profile.kernelVersion,
    kernelFamily: profile.kernelFamily,
    window: { ...profile.window },
    proxy: { ...profile.proxy, password: '', passwordStored: false },
    fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
  }
}

async function readBackupManifest(source: string): Promise<ProfileBackupManifest> {
  const manifestPath = join(source, 'manifest.json')
  if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('备份清单不能超过 1 MB')
  let manifest: ProfileBackupManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProfileBackupManifest
  } catch {
    throw new Error('备份清单不是有效 JSON')
  }
  if (manifest.schemaVersion !== 1 || !manifest.profile || typeof manifest.totalBytes !== 'number' || typeof manifest.fileCount !== 'number') {
    throw new Error('不支持或不完整的 ZBrowser 环境数据备份')
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_BACKUP_BYTES
    || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > MAX_BACKUP_FILES) {
    throw new Error('备份清单中的数据大小或文件数量超出安全范围')
  }
  if (manifest.contentSha256 !== undefined && !/^[a-f\d]{64}$/i.test(manifest.contentSha256)) throw new Error('备份内容摘要无效')
  if (typeof manifest.profile.name !== 'string') throw new Error('备份中的环境名称无效')
  return manifest
}

function checkpointSummary(record: KernelUpgradeCheckpointRecord): KernelUpgradeCheckpointSummary {
  return {
    createdAt: record.createdAt,
    fromVersion: record.fromVersion,
    fromFamily: record.fromFamily,
    toVersion: record.toVersion,
    toFamily: record.toFamily,
    totalBytes: record.totalBytes,
    fileCount: record.fileCount
  }
}

export class ProfileBackupManager {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly appVersion: string,
    private readonly logger?: Logger
  ) {}

  async export(profileId: string, destinationParent: string, options: { excludeDisposableCache?: boolean } = {}): Promise<ProfileBackupResult> {
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再备份完整数据')
    await this.profiles.assertProfileDataIdentity(profileId)
    const source = this.profiles.profileDataPath(profileId)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
    const target = join(resolve(destinationParent), `Prism Backup - ${safeDirectoryName(profile.name)} - ${stamp}`)
    const staging = `${target}.partial`
    ensureOutside(source, target)
    try {
      await stat(target)
      throw new Error('目标备份目录已经存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(staging, { recursive: false })
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    try {
      await copySafeTree(source, join(staging, 'user-data'), stats, '', options.excludeDisposableCache ? disposableKernelUpgradeCache : undefined)
      const contentSha256 = stats.hash.digest('hex')
      const manifest: ProfileBackupManifest = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        sourcePlatform: process.platform,
        sourceAppVersion: this.appVersion,
        totalBytes: stats.bytes,
        fileCount: stats.files,
        contentSha256,
        profile: portableDraft(profile)
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, target)
      this.logger?.info('环境完整数据备份已导出', { profileId, bytes: stats.bytes, files: stats.files })
      return { path: target, totalBytes: stats.bytes, fileCount: stats.files }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async import(sourceInput: string): Promise<{ profile: BrowserProfile; result: ProfileBackupResult }> {
    const source = resolve(sourceInput)
    const manifest = await readBackupManifest(source)
    const userDataSource = join(source, 'user-data')
    const sourceInfo = await lstat(userDataSource)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('备份中的 user-data 目录无效')
    const draft = validateProfileDraft({
      ...manifest.profile,
      kernelVersion: typeof manifest.profile.kernelVersion === 'string' ? manifest.profile.kernelVersion : '',
      name: `${manifest.profile.name.slice(0, 53)}（迁移）`,
      extensionIds: [],
      // A restored browser-data copy must never silently inherit an account proxy binding.
      // Keep the imported environment offline from the old proxy until the user explicitly
      // assigns a fresh, verified proxy from the pool.
      proxy: { protocol: 'direct', host: '', username: '', password: '', passwordStored: false }
    })
    const stagingRoot = await mkdtemp(join(this.profiles.vaultPath, '.profile-backup-import-'))
    const staging = join(stagingRoot, 'user-data')
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    let profile: BrowserProfile | undefined
    try {
      ensureOutside(userDataSource, staging)
      await copySafeTree(userDataSource, staging, stats)
      if (stats.bytes !== manifest.totalBytes || stats.files !== manifest.fileCount) {
        throw new Error('备份数据数量与清单不一致，文件可能不完整')
      }
      const contentSha256 = stats.hash.digest('hex')
      if (manifest.contentSha256 && contentSha256 !== manifest.contentSha256) {
        throw new Error('备份内容 SHA-256 校验失败，文件可能已损坏或被修改')
      }
      profile = await this.profiles.create(draft)
      const target = this.profiles.profileDataPath(profile.id)
      const empty = `${target}.empty-${randomUUID()}`
      await rename(target, empty)
      try {
        await rename(staging, target)
        await rm(empty, { recursive: true, force: true })
      } catch (error) {
        await rename(empty, target).catch(() => undefined)
        throw error
      }
      await this.profiles.assertProfileDataIdentity(profile.id)
      this.logger?.info('环境完整数据备份已导入', { profileId: profile.id, bytes: stats.bytes, files: stats.files })
      return { profile: this.profiles.get(profile.id), result: { path: source, totalBytes: stats.bytes, fileCount: stats.files } }
    } catch (error) {
      if (profile) {
        await this.profiles.remove(profile.id).catch(() => undefined)
        const item = (await this.profiles.listTrash().catch(() => [])).find((candidate) => candidate.profileId === profile!.id)
        if (item) await this.profiles.purgeTrash(item.trashId).catch(() => undefined)
      }
      throw error
    } finally { await rm(stagingRoot, { recursive: true, force: true }) }
  }

  private checkpointRoot(profileId: string): string {
    return join(this.profiles.vaultPath, 'kernel-upgrade-backups', profileId)
  }

  private async readKernelUpgradeCheckpoint(profileId: string): Promise<KernelUpgradeCheckpointRecord | null> {
    const root = this.checkpointRoot(profileId)
    let record: KernelUpgradeCheckpointRecord
    try {
      record = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8')) as KernelUpgradeCheckpointRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('内核升级备份记录损坏')
    }
    if (record.schemaVersion !== 1 || record.profileId !== profileId
      || typeof record.createdAt !== 'string'
      || typeof record.fromVersion !== 'string'
      || (record.fromFamily !== undefined && record.fromFamily !== 'fingerprint-chromium' && record.fromFamily !== 'custom')
      || typeof record.toVersion !== 'string'
      || (record.toFamily !== 'fingerprint-chromium' && record.toFamily !== 'custom')
      || !Number.isSafeInteger(record.totalBytes) || record.totalBytes < 0
      || !Number.isSafeInteger(record.fileCount) || record.fileCount < 0
      || typeof record.backupDirectory !== 'string' || basename(record.backupDirectory) !== record.backupDirectory
      || (record.healthySince !== undefined && (typeof record.healthySince !== 'string' || !Number.isFinite(Date.parse(record.healthySince))))) {
      throw new Error('内核升级备份记录无效')
    }
    return record
  }

  async kernelUpgradeCheckpoint(profileId: string): Promise<KernelUpgradeCheckpointSummary | null> {
    this.profiles.get(profileId)
    const record = await this.readKernelUpgradeCheckpoint(profileId)
    return record ? checkpointSummary(record) : null
  }

  async noteKernelUpgradeHealthyLaunch(profileId: string): Promise<'none' | 'marked' | 'cleaned'> {
    const current = this.profiles.get(profileId)
    const record = await this.readKernelUpgradeCheckpoint(profileId)
    if (!record) return 'none'
    const compatibleCurrent = current.kernelFamily === record.toFamily
      && sameKernelMajor(current.kernelVersion, record.toVersion)
      && compareKernelVersions(current.kernelVersion, record.toVersion) >= 0
    if (!compatibleCurrent) return 'none'

    const now = Date.now()
    if (!record.healthySince) {
      record.healthySince = new Date(now).toISOString()
      const root = this.checkpointRoot(profileId)
      const temporary = join(root, 'latest.json.tmp')
      await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, join(root, 'latest.json'))
      this.logger?.info('内核升级备份进入健康使用保留期', {
        profileId,
        expiresAfterDays: Math.round(KERNEL_UPGRADE_BACKUP_GRACE_MS / 86_400_000)
      })
      return 'marked'
    }

    if (now - Date.parse(record.healthySince) < KERNEL_UPGRADE_BACKUP_GRACE_MS) return 'none'
    await rm(this.checkpointRoot(profileId), { recursive: true, force: true })
    this.logger?.info('已清理超过健康保留期的内核升级备份', { profileId })
    return 'cleaned'
  }

  async createKernelUpgradeCheckpoint(
    profileId: string,
    toVersion: string,
    toFamily: KernelFamily
  ): Promise<KernelUpgradeCheckpointSummary> {
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再升级内核')
    if (!profile.kernelVersion || !profile.kernelFamily) throw new Error('当前环境尚未固定内核，不能创建升级回滚点')
    const root = this.checkpointRoot(profileId)
    await mkdir(root, { recursive: true })
    const exported = await this.export(profileId, root, { excludeDisposableCache: true })
    const record: KernelUpgradeCheckpointRecord = {
      schemaVersion: 1,
      profileId,
      createdAt: new Date().toISOString(),
      fromVersion: profile.kernelVersion,
      fromFamily: profile.kernelFamily,
      toVersion,
      toFamily,
      totalBytes: exported.totalBytes,
      fileCount: exported.fileCount,
      backupDirectory: basename(exported.path)
    }
    const temporary = join(root, 'latest.json.tmp')
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, join(root, 'latest.json'))
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      await rm(exported.path, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== record.backupDirectory) {
        await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    this.logger?.info('已创建内核升级前自动备份', {
      profileId,
      fromVersion: record.fromVersion,
      toVersion: record.toVersion,
      bytes: record.totalBytes,
      files: record.fileCount
    })
    return checkpointSummary(record)
  }

  async rollbackKernelUpgrade(profileId: string): Promise<BrowserProfile> {
    const current = this.profiles.get(profileId)
    if (current.status !== 'closed' && current.status !== 'error') throw new Error('请先关闭浏览器环境再回滚内核')
    const record = await this.readKernelUpgradeCheckpoint(profileId)
    if (!record) throw new Error('没有可用的内核升级前备份')
    const compatibleCurrent = current.kernelFamily === record.toFamily
      && sameKernelMajor(current.kernelVersion, record.toVersion)
      && compareKernelVersions(current.kernelVersion, record.toVersion) >= 0
    if (!compatibleCurrent) {
      throw new Error('当前环境内核与最近升级记录不一致，为保护数据已取消回滚')
    }
    const root = this.checkpointRoot(profileId)
    const rootResolved = resolve(root)
    const source = resolve(root, record.backupDirectory)
    if (source === rootResolved || !source.startsWith(`${rootResolved}${sep}`)) {
      throw new Error('内核升级备份路径无效')
    }
    const manifest = await readBackupManifest(source)
    if (manifest.profile.kernelVersion !== record.fromVersion || manifest.profile.kernelFamily !== record.fromFamily) {
      throw new Error('内核升级备份的版本信息与记录不一致')
    }
    const userDataSource = join(source, 'user-data')
    const sourceInfo = await lstat(userDataSource)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('升级备份中的 user-data 目录无效')

    const stagingRoot = await mkdtemp(join(this.profiles.vaultPath, '.kernel-upgrade-rollback-'))
    const staging = join(stagingRoot, 'user-data')
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    const target = this.profiles.profileDataPath(profileId)
    const previous = `${target}.before-kernel-rollback-${randomUUID()}`
    let swapped = false
    try {
      await copySafeTree(userDataSource, staging, stats)
      if (stats.bytes !== manifest.totalBytes || stats.files !== manifest.fileCount) {
        throw new Error('内核升级备份数据数量与清单不一致')
      }
      const contentSha256 = stats.hash.digest('hex')
      if (manifest.contentSha256 && contentSha256 !== manifest.contentSha256) {
        throw new Error('内核升级备份 SHA-256 校验失败')
      }
      await this.profiles.assertProfileDataIdentity(profileId)
      await renameWithTransientRetry(target, previous)
      try {
        await renameWithTransientRetry(staging, target)
        swapped = true
      } catch (error) {
        await renameWithTransientRetry(previous, target).catch(() => undefined)
        throw error
      }

      let restored: BrowserProfile
      try {
        restored = await this.profiles.restoreKernelBinding(profileId, record.fromVersion, record.fromFamily)
      } catch (error) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        await renameWithTransientRetry(previous, target).catch(() => undefined)
        swapped = false
        throw error
      }
      await rm(previous, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
      this.logger?.info('已回滚环境内核并恢复升级前数据', {
        profileId,
        fromVersion: record.toVersion,
        toVersion: record.fromVersion
      })
      return restored
    } finally {
      if (!swapped) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}
