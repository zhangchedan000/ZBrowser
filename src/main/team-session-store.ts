import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TeamMember } from '../shared/types'
import type { SecretCodec } from './secret-codec'
import type { TeamAuthStore } from './team-auth-store'
import type { TeamStore } from './team-store'

interface TeamSessionFile {
  schemaVersion: 1
  deviceId: string
  deviceRole: 'owner' | 'member'
  memberId?: string
  secret?: string
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

export class TeamSessionStore {
  readonly path: string
  private file!: TeamSessionFile

  constructor(
    vaultPath: string,
    private readonly team: TeamStore,
    private readonly auth: TeamAuthStore,
    private readonly secrets: SecretCodec
  ) {
    this.path = join(vaultPath, 'team-session.json')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<TeamSessionFile>
      if (raw.schemaVersion !== 1 || !validId(raw.deviceId) || (raw.deviceRole !== 'owner' && raw.deviceRole !== 'member')) {
        throw new Error('团队登录会话格式无效')
      }
      this.file = { schemaVersion: 1, deviceId: raw.deviceId, deviceRole: raw.deviceRole }
      if (raw.deviceRole === 'owner') {
        this.file.memberId = this.team.ownerId
      } else if (validId(raw.memberId) && typeof raw.secret === 'string') {
        const secret = this.secrets.decode(raw.secret)
        this.auth.authenticate(raw.memberId, secret)
        this.file.memberId = raw.memberId
        this.file.secret = raw.secret
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.file = {
      schemaVersion: 1,
      deviceId: randomUUID(),
      deviceRole: 'owner',
      memberId: this.team.ownerId
    }
    await this.persist()
  }

  get deviceId(): string {
    return this.file.deviceId
  }

  get deviceRole(): 'owner' | 'member' {
    return this.file.deviceRole
  }

  get memberId(): string {
    const memberId = this.file.memberId
    if (!memberId) throw new Error('当前设备尚未登录子账号')
    return memberId
  }

  sessionMember(): TeamMember {
    return this.team.getMember(this.memberId)
  }

  currentMember(): TeamMember {
    const member = this.sessionMember()
    if (!member.enabled) throw new Error('当前账号已被禁用')
    if (this.file.deviceRole === 'owner' && member.id !== this.team.ownerId) throw new Error('主设备会话身份异常')
    if (this.file.deviceRole === 'member' && member.role !== 'member') throw new Error('子账号设备会话身份异常')
    return member
  }

  async convertToMemberDevice(memberId: string, secret: string): Promise<TeamMember> {
    const member = this.auth.authenticate(memberId, secret)
    this.file = {
      schemaVersion: 1,
      deviceId: this.file.deviceId,
      deviceRole: 'member',
      memberId,
      secret: this.secrets.encode(secret)
    }
    await this.persist()
    return member
  }

  async login(memberId: string, secret: string): Promise<TeamMember> {
    if (this.file.deviceRole !== 'member') throw new Error('主账号设备不能切换为子账号会话')
    const member = this.auth.authenticate(memberId, secret)
    this.file.memberId = memberId
    this.file.secret = this.secrets.encode(secret)
    await this.persist()
    return member
  }

  private async persist(): Promise<void> {
    const temporary = this.path + '.tmp'
    await writeFile(temporary, JSON.stringify(this.file, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}
