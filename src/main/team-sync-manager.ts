import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BrowserProfile, TeamProfileRevision } from '../shared/types'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'
import type { TeamStore } from './team-store'

interface TeamSyncManifest {
  schemaVersion: 1
  snapshotId: string
  createdAt: string
  memberId: string
  profileId: string
  revision: number
  fileCount: number
  totalBytes: number
  contentSha256: string
  profile: BrowserProfile
}

export interface TeamSyncSnapshotSummary {
  path: string
  snapshotId: string
  profileId: string
  memberId: string
  revision: number
  fileCount: number
  totalBytes: number
  contentSha256: string
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function safeRelative(value: string): string {
  const normalized = value.split(sep).join('/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('同步环境包含不安全的文件路径')
  }
  return normalized
}

async function hashFile(path: string, digest: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
}

async function copyAndHashTree(sourceRoot: string, targetRoot: string): Promise<{ fileCount: number; totalBytes: number; contentSha256: string }> {
  const digest = createHash('sha256')
  let fileCount = 0
  let totalBytes = 0
  const visit = async (source: string, rel: string): Promise<void> => {
    const info = await lstat(source)
    if (info.isSymbolicLink()) throw new Error(`同步环境数据包含符号链接：${rel || '.'}`)
    if (info.isDirectory()) {
      const target = rel ? join(targetRoot, rel) : targetRoot
      await mkdir(target, { recursive: true })
      for (const entry of (await readdir(source)).sort()) await visit(join(source, entry), rel ? join(rel, entry) : entry)
      return
    }
    if (!info.isFile()) return
    const archivePath = safeRelative(rel)
    fileCount += 1
    totalBytes += info.size
    digest.update(archivePath).update('\0').update(String(info.size)).update('\0')
    await hashFile(source, digest)
    const target = join(targetRoot, ...archivePath.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  await visit(sourceRoot, '')
  return { fileCount, totalBytes, contentSha256: digest.digest('hex') }
}

async function hashTree(root: string): Promise<{ fileCount: number; totalBytes: number; contentSha256: string }> {
  const digest = createHash('sha256')
  let fileCount = 0
  let totalBytes = 0
  const visit = async (current: string, rel: string): Promise<void> => {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`同步环境数据包含符号链接：${rel || '.'}`)
    if (info.isDirectory()) {
      for (const entry of (await readdir(current)).sort()) await visit(join(current, entry), rel ? join(rel, entry) : entry)
      return
    }
    if (!info.isFile()) return
    const archivePath = safeRelative(rel)
    fileCount += 1
    totalBytes += info.size
    digest.update(archivePath).update('\0').update(String(info.size)).update('\0')
    await hashFile(current, digest)
  }
  await visit(root, '')
  return { fileCount, totalBytes, contentSha256: digest.digest('hex') }
}

function validateManifest(value: unknown): TeamSyncManifest {
  const manifest = value as Partial<TeamSyncManifest>
  if (!manifest || manifest.schemaVersion !== 1 || !validId(manifest.memberId) || !validId(manifest.profileId)
    || typeof manifest.snapshotId !== 'string' || !/^[a-f0-9-]{36}$/i.test(manifest.snapshotId)
    || !Number.isInteger(manifest.revision) || Number(manifest.revision) < 1
    || !Number.isInteger(manifest.fileCount) || Number(manifest.fileCount) < 0
    || !Number.isSafeInteger(manifest.totalBytes) || Number(manifest.totalBytes) < 0
    || typeof manifest.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.contentSha256)
    || !manifest.profile || manifest.profile.id !== manifest.profileId) throw new Error('团队同步快照清单无效')
  return manifest as TeamSyncManifest
}

interface TeamSyncLocalState {
  schemaVersion: 1
  installed: Record<string, string[]>
}

export class TeamSyncManager {
  readonly root: string
  readonly statePath: string

  constructor(
    private readonly profiles: ProfileStore,
    private readonly team: TeamStore,
    private readonly logger?: Logger
  ) {
    this.root = join(profiles.vaultPath, 'team-sync')
    this.statePath = join(this.root, 'state.json')
  }

  async createSnapshot(actorId: string, memberId: string, profileId: string): Promise<TeamSyncSnapshotSummary> {
    const actor = this.team.getMember(actorId)
    if (actor.role !== 'owner' || actor.id !== this.team.ownerId || !actor.enabled) throw new Error('只有主账号可以生成团队同步快照')
    const member = this.team.getMember(memberId)
    if (!member.enabled || member.role !== 'member') throw new Error('目标子账号不可用')
    if (!this.team.assignedMemberIds(profileId).includes(memberId)) throw new Error('该环境尚未分配给目标子账号')
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再同步')
    await this.profiles.assertProfileDataIdentity(profileId)
    await mkdir(this.root, { recursive: true })
    const staging = await mkdtemp(join(this.root, '.snapshot-'))
    try {
      const userData = join(staging, 'user-data')
      const stats = await copyAndHashTree(this.profiles.profileDataPath(profileId), userData)
      const revision = await this.team.recordOwnerSyncedRevision(actorId, profileId, stats.contentSha256)
      const manifest: TeamSyncManifest = {
        schemaVersion: 1,
        snapshotId: randomUUID(),
        createdAt: new Date().toISOString(),
        memberId,
        profileId,
        revision: revision.revision,
        ...stats,
        profile: { ...profile, status: 'closed', lastError: undefined }
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
      this.logger?.info('团队环境同步快照已生成', { memberId, profileId, revision: manifest.revision, totalBytes: manifest.totalBytes })
      return { path: staging, snapshotId: manifest.snapshotId, profileId, memberId, revision: manifest.revision, ...stats }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async applySnapshot(memberId: string, snapshotPathInput: string): Promise<TeamProfileRevision> {
    const member = this.team.getMember(memberId)
    if (!member.enabled || member.role !== 'member') throw new Error('当前子账号不可用')
    const snapshotPath = resolve(snapshotPathInput)
    const manifest = validateManifest(JSON.parse(await readFile(join(snapshotPath, 'manifest.json'), 'utf8')))
    if (manifest.memberId !== memberId) throw new Error('该同步快照不属于当前子账号')
    this.team.assertCanUse(memberId, manifest.profileId)
    const currentRevision = this.team.revision(manifest.profileId)
    if (manifest.revision < currentRevision.revision) throw new Error('同步快照版本低于本地版本')
    const userData = join(snapshotPath, 'user-data')
    const stats = await hashTree(userData)
    if (stats.fileCount !== manifest.fileCount || stats.totalBytes !== manifest.totalBytes || stats.contentSha256 !== manifest.contentSha256) {
      throw new Error('团队同步快照完整性校验失败')
    }
    await this.profiles.installSyncedProfile(manifest.profile, userData)
    const state = await this.readLocalState()
    const installed = new Set(state.installed[memberId] ?? [])
    installed.add(manifest.profileId)
    state.installed[memberId] = [...installed].sort()
    await this.writeLocalState(state)
    const recorded = await this.team.acceptSyncedRevision(memberId, manifest.profileId, manifest.revision, manifest.contentSha256)
    this.logger?.info('团队环境同步快照已应用', { memberId, profileId: manifest.profileId, revision: manifest.revision })
    return recorded
  }

  async removeRevokedLocalProfiles(memberId: string): Promise<string[]> {
    const member = this.team.getMember(memberId)
    if (member.role !== 'member') return []
    const assigned = new Set(this.team.state().assignments.filter((item) => item.memberIds.includes(memberId)).map((item) => item.profileId))
    const state = await this.readLocalState()
    const installed = new Set(state.installed[memberId] ?? [])
    const removed: string[] = []
    for (const profileId of installed) {
      if (assigned.has(profileId)) continue
      const profile = this.profiles.list().find((item) => item.id === profileId)
      if (profile) {
        if (profile.status !== 'closed' && profile.status !== 'error') throw new Error(`环境“${profile.name}”仍在运行，无法执行收回清理`)
        await this.profiles.remove(profile.id)
        const trash = (await this.profiles.listTrash()).find((item) => item.profileId === profile.id)
        if (trash) await this.profiles.purgeTrash(trash.trashId)
      }
      installed.delete(profileId)
      removed.push(profileId)
    }
    state.installed[memberId] = [...installed].sort()
    await this.writeLocalState(state)
    return removed
  }

  private async readLocalState(): Promise<TeamSyncLocalState> {
    try {
      const value = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<TeamSyncLocalState>
      if (value.schemaVersion !== 1 || !value.installed || typeof value.installed !== 'object') throw new Error('团队同步本地状态无效')
      const installed: Record<string, string[]> = {}
      for (const [memberId, ids] of Object.entries(value.installed)) {
        if (!validId(memberId) || !Array.isArray(ids) || !ids.every(validId)) throw new Error('团队同步本地状态无效')
        installed[memberId] = [...new Set(ids)]
      }
      return { schemaVersion: 1, installed }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, installed: {} }
    }
  }

  private async writeLocalState(state: TeamSyncLocalState): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const temporary = this.statePath + '.tmp'
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.statePath)
  }
}