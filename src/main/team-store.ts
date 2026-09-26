import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  TeamAuditEvent,
  TeamAuditEventType,
  TeamMember,
  TeamMemberPatch,
  TeamProfileAssignment,
  TeamProfileLease,
  TeamProfileRevision,
  TeamState
} from '../shared/types'

interface TeamFile {
  schemaVersion: 1
  ownerId: string
  members: TeamMember[]
  assignments: TeamProfileAssignment[]
  leases: TeamProfileLease[]
  revisions: TeamProfileRevision[]
  audit: TeamAuditEvent[]
}

const MAX_MEMBERS = 500
const MAX_AUDIT = 5000
const DEFAULT_LEASE_MS = 2 * 60_000
const MIN_LEASE_MS = 30_000
const MAX_LEASE_MS = 10 * 60_000

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function normalizeMemberName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('成员名称格式无效')
  const name = value.trim()
  if (!name) throw new Error('成员名称不能为空')
  if (name.length > 60) throw new Error('成员名称不能超过 60 个字符')
  return name
}

function safeDate(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

function uniqIds(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || !values.every(validId)) throw new Error(`${label}格式无效`)
  return [...new Set(values)]
}

export class TeamStore {
  readonly path: string
  readonly backupPath: string
  private ownerMemberId = ''
  private members = new Map<string, TeamMember>()
  private assignments = new Map<string, TeamProfileAssignment>()
  private leases = new Map<string, TeamProfileLease>()
  private revisions = new Map<string, TeamProfileRevision>()
  private auditEvents: TeamAuditEvent[] = []
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'team.json')
    this.backupPath = join(vaultPath, 'team.json.backup')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    let loaded: TeamFile | undefined
    for (const candidate of [this.path, this.backupPath]) {
      try {
        loaded = await this.read(candidate)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      }
    }

    if (!loaded) {
      const now = new Date().toISOString()
      const owner: TeamMember = {
        id: randomUUID(),
        name: '主账号',
        role: 'owner',
        enabled: true,
        createdAt: now,
        updatedAt: now
      }
      this.ownerMemberId = owner.id
      this.members.set(owner.id, owner)
      this.record('team_created', owner.id, {})
      await this.persist()
      return
    }

    this.ownerMemberId = loaded.ownerId
    this.members = new Map(loaded.members.map((member) => [member.id, member]))
    this.assignments = new Map(loaded.assignments.map((assignment) => [assignment.profileId, assignment]))
    this.leases = new Map(loaded.leases.map((lease) => [lease.profileId, lease]))
    this.revisions = new Map(loaded.revisions.map((revision) => [revision.profileId, revision]))
    this.auditEvents = loaded.audit

    const now = Date.now()
    let changed = false
    for (const [profileId, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) <= now) {
        this.leases.delete(profileId)
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  get ownerId(): string {
    return this.ownerMemberId
  }

  state(): TeamState {
    return {
      ownerId: this.ownerMemberId,
      members: this.listMembers(),
      assignments: [...this.assignments.values()]
        .sort((a, b) => a.profileId.localeCompare(b.profileId))
        .map((item) => ({ ...item, memberIds: [...item.memberIds] })),
      leases: [...this.leases.values()].map((item) => ({ ...item })),
      revisions: [...this.revisions.values()].map((item) => ({ ...item }))
    }
  }

  listMembers(): TeamMember[] {
    return [...this.members.values()]
      .sort((a, b) => a.role === b.role ? a.createdAt.localeCompare(b.createdAt) : a.role === 'owner' ? -1 : 1)
      .map((member) => ({ ...member }))
  }

  getMember(id: string): TeamMember {
    if (!validId(id)) throw new Error('成员 ID 无效')
    const member = this.members.get(id)
    if (!member) throw new Error('成员不存在')
    return { ...member }
  }

  async createMember(actorId: string, nameInput: string): Promise<TeamMember> {
    this.assertOwner(actorId)
    if (this.members.size >= MAX_MEMBERS) throw new Error(`团队成员最多 ${MAX_MEMBERS} 个`)
    const name = normalizeMemberName(nameInput)
    if ([...this.members.values()].some((member) => member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('成员名称已存在')
    }
    const now = new Date().toISOString()
    const member: TeamMember = {
      id: randomUUID(),
      name,
      role: 'member',
      enabled: true,
      createdAt: now,
      updatedAt: now
    }
    this.members.set(member.id, member)
    this.record('member_created', actorId, { targetMemberId: member.id })
    await this.persist()
    return { ...member }
  }

  async updateMember(actorId: string, memberId: string, patch: TeamMemberPatch): Promise<TeamMember> {
    this.assertOwner(actorId)
    const current = this.internalMember(memberId)
    if (current.role === 'owner' && patch.enabled === false) throw new Error('主账号不能被禁用')
    const name = patch.name === undefined ? current.name : normalizeMemberName(patch.name)
    if ([...this.members.values()].some((member) => member.id !== memberId && member.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('成员名称已存在')
    }
    const next: TeamMember = {
      ...current,
      name,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      updatedAt: new Date().toISOString()
    }
    this.members.set(memberId, next)
    if (!next.enabled) {
      for (const [profileId, lease] of this.leases) {
        if (lease.memberId === memberId) this.leases.delete(profileId)
      }
    }
    this.record(next.enabled ? 'member_updated' : 'member_disabled', actorId, { targetMemberId: memberId })
    await this.persist()
    return { ...next }
  }

  async setProfileAssignments(actorId: string, profileId: string, memberIdsInput: string[]): Promise<TeamProfileAssignment> {
    this.assertOwner(actorId)
    if (!validId(profileId)) throw new Error('环境 ID 无效')
    const memberIds = uniqIds(memberIdsInput, '成员列表')
    for (const memberId of memberIds) {
      const member = this.internalMember(memberId)
      if (member.role === 'owner') throw new Error('主账号默认拥有全部环境，无需分配')
      if (!member.enabled) throw new Error(`成员“${member.name}”已禁用`)
    }
    const assignment: TeamProfileAssignment = {
      profileId,
      memberIds,
      updatedAt: new Date().toISOString()
    }
    this.assignments.set(profileId, assignment)
    const lease = this.currentLease(profileId)
    if (lease && !this.canUse(lease.memberId, profileId)) this.leases.delete(profileId)
    this.record(memberIds.length ? 'profile_assigned' : 'profile_unassigned', actorId, { profileId, memberIds })
    await this.persist()
    return { ...assignment, memberIds: [...assignment.memberIds] }
  }

  async setManyProfileAssignments(actorId: string, profileIdsInput: string[], memberIdsInput: string[]): Promise<TeamProfileAssignment[]> {
    this.assertOwner(actorId)
    const profileIds = uniqIds(profileIdsInput, '环境列表')
    const memberIds = uniqIds(memberIdsInput, '成员列表')
    const results: TeamProfileAssignment[] = []
    for (const profileId of profileIds) {
      results.push(await this.setProfileAssignments(actorId, profileId, memberIds))
    }
    return results
  }

  assignedMemberIds(profileId: string): string[] {
    return [...(this.assignments.get(profileId)?.memberIds ?? [])]
  }

  canUse(memberId: string, profileId: string): boolean {
    const member = this.members.get(memberId)
    if (!member?.enabled) return false
    if (member.role === 'owner') return true
    return this.assignments.get(profileId)?.memberIds.includes(memberId) === true
  }

  assertCanUse(memberId: string, profileId: string): void {
    const member = this.internalMember(memberId)
    if (!member.enabled) throw new Error('当前子账号已被禁用')
    if (member.role !== 'owner' && !this.assignments.get(profileId)?.memberIds.includes(memberId)) {
      throw new Error('当前子账号没有该环境的使用权限')
    }
  }

  async acquireLease(memberId: string, deviceId: string, profileId: string, ttlMs = DEFAULT_LEASE_MS): Promise<TeamProfileLease> {
    this.assertCanUse(memberId, profileId)
    if (!validId(deviceId)) throw new Error('设备 ID 无效')
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_LEASE_MS || ttlMs > MAX_LEASE_MS) throw new Error('占用租约时长无效')
    const current = this.currentLease(profileId)
    const now = Date.now()
    if (current && (current.memberId !== memberId || current.deviceId !== deviceId)) {
      const holder = this.internalMember(current.memberId)
      throw new Error(`环境正在由“${holder.name}”使用`)
    }
    const lease: TeamProfileLease = current
      ? { ...current, expiresAt: new Date(now + ttlMs).toISOString() }
      : {
          profileId,
          leaseId: randomUUID(),
          memberId,
          deviceId,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttlMs).toISOString()
        }
    this.leases.set(profileId, lease)
    this.record(current ? 'lease_renewed' : 'lease_acquired', memberId, { profileId, deviceId })
    await this.persist()
    return { ...lease }
  }

  async renewLease(memberId: string, deviceId: string, profileId: string, ttlMs = DEFAULT_LEASE_MS): Promise<TeamProfileLease> {
    const current = this.currentLease(profileId)
    if (!current || current.memberId !== memberId || current.deviceId !== deviceId) throw new Error('当前设备未持有该环境')
    return this.acquireLease(memberId, deviceId, profileId, ttlMs)
  }

  async releaseLease(memberId: string, deviceId: string, profileId: string): Promise<void> {
    const current = this.currentLease(profileId)
    if (!current) return
    if (current.memberId !== memberId || current.deviceId !== deviceId) throw new Error('当前设备未持有该环境')
    this.leases.delete(profileId)
    this.record('lease_released', memberId, { profileId, deviceId })
    await this.persist()
  }

  async forceRelease(actorId: string, profileId: string): Promise<void> {
    this.assertOwner(actorId)
    if (!validId(profileId)) throw new Error('环境 ID 无效')
    const lease = this.currentLease(profileId)
    if (!lease) return
    this.leases.delete(profileId)
    this.record('lease_force_released', actorId, { profileId, targetMemberId: lease.memberId, deviceId: lease.deviceId })
    await this.persist()
  }

  revision(profileId: string): TeamProfileRevision {
    if (!validId(profileId)) throw new Error('环境 ID 无效')
    return { ...(this.revisions.get(profileId) ?? { profileId, revision: 0 }) }
  }

  async recordSyncedRevision(memberId: string, deviceId: string, profileId: string, checksum?: string): Promise<TeamProfileRevision> {
    this.assertCanUse(memberId, profileId)
    const lease = this.currentLease(profileId)
    if (!lease || lease.memberId !== memberId || lease.deviceId !== deviceId) throw new Error('同步前必须持有该环境')
    const current = this.revision(profileId)
    const next: TeamProfileRevision = {
      profileId,
      revision: current.revision + 1,
      lastSyncedAt: new Date().toISOString(),
      lastMemberId: memberId,
      lastDeviceId: deviceId,
      checksum: typeof checksum === 'string' && /^[a-f0-9]{64}$/i.test(checksum) ? checksum.toLowerCase() : undefined
    }
    this.revisions.set(profileId, next)
    this.record('profile_synced', memberId, { profileId, deviceId, revision: next.revision })
    await this.persist()
    return { ...next }
  }

  async onProfileTrashed(actorId: string, profileId: string): Promise<void> {
    this.assertOwner(actorId)
    if (!validId(profileId)) throw new Error('环境 ID 无效')
    this.assignments.delete(profileId)
    this.leases.delete(profileId)
    this.record('profile_trashed', actorId, { profileId })
    await this.persist()
  }

  async onProfileRestored(actorId: string, profileId: string): Promise<void> {
    this.assertOwner(actorId)
    if (!validId(profileId)) throw new Error('环境 ID 无效')
    this.assignments.delete(profileId)
    this.leases.delete(profileId)
    this.record('profile_restored', actorId, { profileId })
    await this.persist()
  }

  audit(limit = 200): TeamAuditEvent[] {
    const safeLimit = Math.max(1, Math.min(MAX_AUDIT, Math.floor(limit)))
    return this.auditEvents.slice(-safeLimit).reverse().map((event) => ({ ...event, memberIds: event.memberIds ? [...event.memberIds] : undefined }))
  }

  private currentLease(profileId: string): TeamProfileLease | undefined {
    const lease = this.leases.get(profileId)
    if (!lease) return undefined
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      this.leases.delete(profileId)
      return undefined
    }
    return lease
  }

  private internalMember(id: string): TeamMember {
    if (!validId(id)) throw new Error('成员 ID 无效')
    const member = this.members.get(id)
    if (!member) throw new Error('成员不存在')
    return member
  }

  private assertOwner(actorId: string): void {
    const member = this.internalMember(actorId)
    if (!member.enabled || member.role !== 'owner' || member.id !== this.ownerMemberId) throw new Error('只有主账号可以执行该操作')
  }

  private record(type: TeamAuditEventType, actorMemberId: string, details: Partial<Omit<TeamAuditEvent, 'id' | 'type' | 'actorMemberId' | 'createdAt'>>): void {
    this.auditEvents.push({
      id: randomUUID(),
      type,
      actorMemberId,
      createdAt: new Date().toISOString(),
      ...details
    })
    if (this.auditEvents.length > MAX_AUDIT) this.auditEvents.splice(0, this.auditEvents.length - MAX_AUDIT)
  }

  private async read(path: string): Promise<TeamFile> {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<TeamFile>
    if (raw.schemaVersion !== 1 || !validId(raw.ownerId) || !Array.isArray(raw.members)
      || !Array.isArray(raw.assignments) || !Array.isArray(raw.leases) || !Array.isArray(raw.revisions) || !Array.isArray(raw.audit)) {
      throw new Error('团队数据格式无效')
    }
    if (raw.members.length < 1 || raw.members.length > MAX_MEMBERS) throw new Error('团队成员数量无效')
    const members: TeamMember[] = []
    const memberIds = new Set<string>()
    for (const value of raw.members) {
      const member = value as Partial<TeamMember>
      if (!validId(member.id) || memberIds.has(member.id) || (member.role !== 'owner' && member.role !== 'member')) throw new Error('团队成员数据无效')
      const createdAt = safeDate(member.createdAt)
      const updatedAt = safeDate(member.updatedAt)
      if (!createdAt || !updatedAt) throw new Error('团队成员时间字段无效')
      memberIds.add(member.id)
      members.push({
        id: member.id,
        name: normalizeMemberName(member.name),
        role: member.role,
        enabled: member.enabled !== false,
        createdAt,
        updatedAt
      })
    }
    const owner = members.find((member) => member.id === raw.ownerId)
    if (!owner || owner.role !== 'owner' || members.filter((member) => member.role === 'owner').length !== 1) throw new Error('团队主账号数据无效')

    const assignments: TeamProfileAssignment[] = raw.assignments.map((value) => {
      const item = value as Partial<TeamProfileAssignment>
      if (!validId(item.profileId)) throw new Error('环境分配数据无效')
      const memberIdsForProfile = uniqIds(item.memberIds, '环境分配成员列表')
      if (memberIdsForProfile.some((id) => !memberIds.has(id) || id === raw.ownerId)) throw new Error('环境分配包含无效成员')
      const updatedAt = safeDate(item.updatedAt)
      if (!updatedAt) throw new Error('环境分配时间字段无效')
      return { profileId: item.profileId, memberIds: memberIdsForProfile, updatedAt }
    })
    if (new Set(assignments.map((item) => item.profileId)).size !== assignments.length) throw new Error('环境分配包含重复环境')

    const leases: TeamProfileLease[] = raw.leases.map((value) => {
      const item = value as Partial<TeamProfileLease>
      if (!validId(item.profileId) || !validId(item.leaseId) || !validId(item.memberId) || !validId(item.deviceId)
        || !memberIds.has(item.memberId) || !safeDate(item.acquiredAt) || !safeDate(item.expiresAt)) throw new Error('环境占用数据无效')
      return item as TeamProfileLease
    })
    if (new Set(leases.map((item) => item.profileId)).size !== leases.length) throw new Error('环境占用包含重复环境')

    const revisions: TeamProfileRevision[] = raw.revisions.map((value) => {
      const item = value as Partial<TeamProfileRevision>
      if (!validId(item.profileId) || !Number.isInteger(item.revision) || Number(item.revision) < 0) throw new Error('环境版本数据无效')
      return {
        profileId: item.profileId,
        revision: Number(item.revision),
        lastSyncedAt: safeDate(item.lastSyncedAt),
        lastMemberId: validId(item.lastMemberId) ? item.lastMemberId : undefined,
        lastDeviceId: validId(item.lastDeviceId) ? item.lastDeviceId : undefined,
        checksum: typeof item.checksum === 'string' && /^[a-f0-9]{64}$/i.test(item.checksum) ? item.checksum.toLowerCase() : undefined
      }
    })

    const audit = raw.audit.slice(-MAX_AUDIT).filter((value): value is TeamAuditEvent => {
      const item = value as Partial<TeamAuditEvent>
      return validId(item.id) && typeof item.type === 'string' && validId(item.actorMemberId) && Boolean(safeDate(item.createdAt))
    })

    return { schemaVersion: 1, ownerId: raw.ownerId, members, assignments, leases, revisions, audit }
  }

  private persist(): Promise<void> {
    const data: TeamFile = {
      schemaVersion: 1,
      ownerId: this.ownerMemberId,
      members: [...this.members.values()],
      assignments: [...this.assignments.values()],
      leases: [...this.leases.values()],
      revisions: [...this.revisions.values()],
      audit: this.auditEvents
    }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = this.path + '.tmp'
      await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.path)
      const backupTemporary = this.backupPath + '.tmp'
      try {
        await copyFile(this.path, backupTemporary)
        await rm(this.backupPath, { force: true })
        await rename(backupTemporary, this.backupPath)
      } catch {
        await rm(backupTemporary, { force: true })
      }
    })
    this.writeQueue = operation
    return operation
  }
}