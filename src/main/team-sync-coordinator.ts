import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { TeamSyncStatus } from '../shared/types'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import type { TeamAuthStore } from './team-auth-store'
import type { TeamSessionStore } from './team-session-store'
import type { TeamStore } from './team-store'
import { decryptTeamSyncArchive, encryptTeamSyncDirectory } from './team-sync-archive'
import type { TeamSyncManager } from './team-sync-manager'

interface RemoteSnapshotRef {
  profileId: string
  revision: number
  archive: string
  checksum?: string
}

interface RemoteMemberState {
  schemaVersion: 1
  ownerId: string
  memberId: string
  enabled: boolean
  updatedAt: string
  assignedProfileIds: string[]
  snapshots: RemoteSnapshotRef[]
}

interface EncryptedStateEnvelope {
  schemaVersion: 1
  nonce: string
  tag: string
  ciphertext: string
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function encryptState(state: RemoteMemberState, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  const envelope: EncryptedStateEnvelope = {
    schemaVersion: 1,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
  return JSON.stringify(envelope)
}

function decryptState(raw: string, key: Buffer): RemoteMemberState {
  let envelope: EncryptedStateEnvelope
  try { envelope = JSON.parse(raw) as EncryptedStateEnvelope } catch { throw new Error('团队同步状态文件损坏') }
  if (envelope.schemaVersion !== 1 || typeof envelope.nonce !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw new Error('团队同步状态文件格式无效')
  }
  const nonce = Buffer.from(envelope.nonce, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('团队同步状态加密参数无效')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    const state = JSON.parse(plaintext) as Partial<RemoteMemberState>
    if (state.schemaVersion !== 1 || !validId(state.ownerId) || !validId(state.memberId) || typeof state.enabled !== 'boolean'
      || typeof state.updatedAt !== 'string' || !Array.isArray(state.assignedProfileIds) || !state.assignedProfileIds.every(validId)
      || !Array.isArray(state.snapshots)) throw new Error('团队同步状态内容无效')
    const snapshots = state.snapshots.map((item) => {
      if (!item || !validId(item.profileId) || !Number.isInteger(item.revision) || item.revision < 1
        || typeof item.archive !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(item.archive)) throw new Error('团队同步快照索引无效')
      return { profileId: item.profileId, revision: item.revision, archive: item.archive, checksum: item.checksum }
    })
    return { ...state, assignedProfileIds: [...new Set(state.assignedProfileIds)], snapshots } as RemoteMemberState
  } catch (error) {
    if ((error as Error).message.includes('authenticate data')) throw new Error('团队同步状态密钥错误或文件已损坏')
    throw error
  }
}

export class TeamSyncCoordinator {
  private timer?: NodeJS.Timeout
  private inFlight?: Promise<TeamSyncStatus>
  private lastRunAt?: string
  private lastError?: string
  private lastPublishedProfiles = 0
  private lastAppliedProfiles = 0
  private lastRemovedProfiles = 0

  constructor(
    private readonly profiles: ProfileStore,
    private readonly team: TeamStore,
    private readonly auth: TeamAuthStore,
    private readonly session: TeamSessionStore,
    private readonly sync: TeamSyncManager,
    private readonly settings: SettingsStore,
    private readonly logger?: Logger
  ) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined) }, intervalMs)
    this.timer.unref()
    const initial = setTimeout(() => { void this.runOnce().catch(() => undefined) }, 2_000)
    initial.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  status(): TeamSyncStatus {
    const directory = this.settings.get().teamSyncDirectory.trim()
    return {
      configured: Boolean(directory),
      directory: directory || undefined,
      mode: this.session.deviceRole,
      running: Boolean(this.inFlight),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastPublishedProfiles: this.lastPublishedProfiles,
      lastAppliedProfiles: this.lastAppliedProfiles,
      lastRemovedProfiles: this.lastRemovedProfiles
    }
  }

  runOnce(): Promise<TeamSyncStatus> {
    if (this.inFlight) return this.inFlight
    const run = this.performRun()
    this.inFlight = run.finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  async publishProfile(profileId: string): Promise<TeamSyncStatus> {
    if (this.session.deviceRole !== 'owner') return this.status()
    const directory = this.settings.get().teamSyncDirectory.trim()
    if (!directory) return this.status()
    const targets = this.team.state().assignments
      .filter((assignment) => assignment.profileId === profileId)
      .flatMap((assignment) => assignment.memberIds)
    let published = 0
    for (const memberId of [...new Set(targets)]) {
      if (!this.auth.hasCredential(memberId)) continue
      published += await this.publishMember(resolve(directory), memberId, new Set([profileId]))
    }
    this.lastPublishedProfiles = published
    this.lastRunAt = new Date().toISOString()
    this.lastError = undefined
    return this.status()
  }

  private async performRun(): Promise<TeamSyncStatus> {
    const directory = this.settings.get().teamSyncDirectory.trim()
    this.lastPublishedProfiles = 0
    this.lastAppliedProfiles = 0
    this.lastRemovedProfiles = 0
    if (!directory) return this.status()
    try {
      const root = resolve(directory)
      await mkdir(root, { recursive: true })
      if (this.session.deviceRole === 'owner') {
        for (const member of this.team.listMembers().filter((item) => item.role === 'member')) {
          if (!this.auth.hasCredential(member.id)) continue
          this.lastPublishedProfiles += await this.publishMember(root, member.id, new Set())
        }
      } else {
        const result = await this.pullMember(root, this.session.memberId)
        this.lastAppliedProfiles = result.applied
        this.lastRemovedProfiles = result.removed
      }
      this.lastRunAt = new Date().toISOString()
      this.lastError = undefined
    } catch (error) {
      this.lastRunAt = new Date().toISOString()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.error('团队自动同步失败', error)
      throw error
    }
    return this.status()
  }

  private memberRoot(syncRoot: string, memberId: string): string {
    return join(syncRoot, `team-${this.team.ownerId}`, `member-${memberId}`)
  }

  private async publishMember(syncRoot: string, memberId: string, forceProfileIds: Set<string>): Promise<number> {
    const member = this.team.getMember(memberId)
    const key = this.auth.credentialKey(memberId)
    const root = this.memberRoot(syncRoot, memberId)
    const profilesRoot = join(root, 'profiles')
    await mkdir(profilesRoot, { recursive: true })
    const assignedProfileIds = member.enabled
      ? this.team.state().assignments.filter((assignment) => assignment.memberIds.includes(memberId)).map((assignment) => assignment.profileId).sort()
      : []
    const snapshots: RemoteSnapshotRef[] = []
    let published = 0
    for (const profileId of assignedProfileIds) {
      const profile = this.profiles.get(profileId)
      let revision = this.team.revision(profileId)
      let archiveName = revision.revision > 0 ? `${profileId}-r${revision.revision}.zbsync` : ''
      let archivePath = archiveName ? join(profilesRoot, archiveName) : ''
      let archiveExists = false
      if (archivePath) {
        try { archiveExists = (await stat(archivePath)).isFile() } catch { archiveExists = false }
      }
      const shouldRefresh = forceProfileIds.has(profileId) || !archiveExists || revision.revision === 0
      if (shouldRefresh && (profile.status === 'closed' || profile.status === 'error')) {
        const snapshot = await this.sync.createSnapshot(this.team.ownerId, memberId, profileId)
        try {
          revision = this.team.revision(profileId)
          archiveName = `${profileId}-r${revision.revision}.zbsync`
          archivePath = join(profilesRoot, archiveName)
          try { archiveExists = (await stat(archivePath)).isFile() } catch { archiveExists = false }
          if (!archiveExists || forceProfileIds.has(profileId)) {
            await encryptTeamSyncDirectory(snapshot.path, archivePath, key)
            published += 1
          }
        } finally {
          await rm(snapshot.path, { recursive: true, force: true })
        }
      }
      if (archiveName) {
        try {
          if ((await stat(join(profilesRoot, archiveName))).isFile()) {
            snapshots.push({ profileId, revision: revision.revision, archive: archiveName, checksum: revision.checksum })
          }
        } catch { /* snapshot will be published after the environment closes */ }
      }
    }
    const state: RemoteMemberState = {
      schemaVersion: 1,
      ownerId: this.team.ownerId,
      memberId,
      enabled: member.enabled,
      updatedAt: new Date().toISOString(),
      assignedProfileIds,
      snapshots
    }
    const statePath = join(root, 'state.zbstate')
    const temporary = statePath + '.tmp'
    await writeFile(temporary, encryptState(state, key), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, statePath)

    const keep = new Set(snapshots.map((item) => item.archive))
    for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.zbsync') && !keep.has(entry.name)) {
        await rm(join(profilesRoot, entry.name), { force: true }).catch(() => undefined)
      }
    }
    return published
  }

  private async pullMember(syncRoot: string, memberId: string): Promise<{ applied: number; removed: number }> {
    const key = this.auth.credentialKey(memberId)
    const root = this.memberRoot(syncRoot, memberId)
    const statePath = join(root, 'state.zbstate')
    let raw: string
    try { raw = await readFile(statePath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { applied: 0, removed: 0 }
      throw error
    }
    const state = decryptState(raw, key)
    if (state.ownerId !== this.team.ownerId || state.memberId !== memberId) throw new Error('团队同步状态与当前账号不匹配')
    await this.team.applyReplicaState(memberId, state.enabled, state.assignedProfileIds)
    let applied = 0
    if (state.enabled) {
      for (const snapshot of state.snapshots) {
        if (!state.assignedProfileIds.includes(snapshot.profileId)) continue
        const local = this.team.revision(snapshot.profileId)
        const exists = this.profiles.list().some((profile) => profile.id === snapshot.profileId)
        if (exists && local.revision >= snapshot.revision) continue
        const archive = join(root, 'profiles', snapshot.archive)
        const staging = await mkdtemp(join(this.sync.root, '.incoming-'))
        try {
          await decryptTeamSyncArchive(archive, staging, key)
          await this.sync.applySnapshot(memberId, staging)
          applied += 1
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      }
    }
    const removedIds = await this.sync.removeRevokedLocalProfiles(memberId)
    return { applied, removed: removedIds.length }
  }
}
