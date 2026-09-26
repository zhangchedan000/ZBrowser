import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { TeamMember } from '../shared/types'
import type { ProfileStore } from './profile-store'
import type { TeamAuthStore, TeamLoginCredential } from './team-auth-store'
import type { TeamSessionStore } from './team-session-store'
import type { TeamStore } from './team-store'
import type { TeamSyncManager } from './team-sync-manager'

interface TeamEnrollmentFile {
  schemaVersion: 1
  createdAt: string
  owner: TeamMember
  member: TeamMember
  profileIds: string[]
  credential: TeamLoginCredential
}

export interface TeamEnrollmentResult {
  path: string
  memberId: string
  profileCount: number
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function validateEnrollment(value: unknown): TeamEnrollmentFile {
  const item = value as Partial<TeamEnrollmentFile>
  if (!item || item.schemaVersion !== 1 || !item.owner || !item.member || !item.credential
    || item.owner.role !== 'owner' || !item.owner.enabled || !validId(item.owner.id)
    || item.member.role !== 'member' || !item.member.enabled || !validId(item.member.id)
    || item.member.id === item.owner.id || item.credential.memberId !== item.member.id
    || typeof item.credential.secret !== 'string' || !/^[A-Za-z0-9_-]{43,100}$/.test(item.credential.secret)
    || !Array.isArray(item.profileIds) || !item.profileIds.every(validId)) {
    throw new Error('团队子账号邀请包无效')
  }
  return { ...item, profileIds: [...new Set(item.profileIds)] } as TeamEnrollmentFile
}

export class TeamEnrollmentManager {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly team: TeamStore,
    private readonly auth: TeamAuthStore,
    private readonly session: TeamSessionStore,
    private readonly sync: TeamSyncManager
  ) {}

  async exportBundle(actorId: string, memberId: string, destinationInput: string): Promise<TeamEnrollmentResult> {
    const actor = this.team.getMember(actorId)
    if (actor.role !== 'owner' || actor.id !== this.team.ownerId || !actor.enabled) throw new Error('只有主账号可以导出子账号环境包')
    const member = this.team.getMember(memberId)
    if (member.role !== 'member' || !member.enabled) throw new Error('目标子账号不可用')
    const profileIds = this.team.state().assignments
      .filter((assignment) => assignment.memberIds.includes(memberId))
      .map((assignment) => assignment.profileId)
      .sort()
    for (const profileId of profileIds) {
      const profile = this.profiles.get(profileId)
      if (profile.status !== 'closed' && profile.status !== 'error') throw new Error(`请先关闭环境“${profile.name}”再导出子账号环境包`)
    }
    const destination = resolve(destinationInput)
    try {
      await stat(destination)
      throw new Error('目标子账号环境包已经存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(dirname(destination), { recursive: true })
    const staging = `${destination}.partial-${randomUUID()}`
    await mkdir(join(staging, 'profiles'), { recursive: true, mode: 0o700 })
    try {
      const credential = await this.auth.issue(actorId, memberId)
      const enrollment: TeamEnrollmentFile = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        owner: { ...actor },
        member: { ...member },
        profileIds,
        credential
      }
      await writeFile(join(staging, 'invite.json'), JSON.stringify(enrollment, null, 2), { encoding: 'utf8', mode: 0o600 })
      for (const profileId of profileIds) {
        const snapshot = await this.sync.createSnapshot(actorId, memberId, profileId)
        const target = join(staging, 'profiles', profileId)
        await cp(snapshot.path, target, { recursive: true, force: false, errorOnExist: true, dereference: false })
        await rm(snapshot.path, { recursive: true, force: true })
      }
      await rename(staging, destination)
      return { path: destination, memberId, profileCount: profileIds.length }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async importBundle(sourceInput: string): Promise<TeamEnrollmentResult> {
    if (this.session.deviceRole !== 'owner' || !this.team.isPristineOwnerDevice() || this.profiles.list().length !== 0) {
      throw new Error('子账号环境包只能导入到尚未使用的新设备')
    }
    const source = resolve(sourceInput)
    const info = await lstat(source)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('团队子账号环境包目录无效')
    const enrollment = validateEnrollment(JSON.parse(await readFile(join(source, 'invite.json'), 'utf8')))
    for (const profileId of enrollment.profileIds) {
      const snapshotInfo = await lstat(join(source, 'profiles', profileId))
      if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw new Error(`环境 ${profileId.slice(0, 8)} 的同步快照缺失`)
    }
    await this.team.installMemberReplica(enrollment.owner, enrollment.member, enrollment.profileIds)
    await this.auth.installCredential(enrollment.member.id, enrollment.credential.secret)
    await this.session.convertToMemberDevice(enrollment.member.id, enrollment.credential.secret)
    for (const profileId of enrollment.profileIds) {
      await this.sync.applySnapshot(enrollment.member.id, join(source, 'profiles', profileId))
    }
    return { path: source, memberId: enrollment.member.id, profileCount: enrollment.profileIds.length }
  }
}