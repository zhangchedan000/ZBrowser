import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TeamMember } from '../shared/types'
import type { TeamStore } from './team-store'

interface TeamCredentialRecord {
  memberId: string
  secretHash: string
  createdAt: string
  updatedAt: string
}

interface TeamAuthFile {
  schemaVersion: 1
  credentials: TeamCredentialRecord[]
}

export interface TeamLoginCredential {
  memberId: string
  secret: string
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

function validSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{43,100}$/.test(secret)
}

export class TeamAuthStore {
  readonly path: string
  private credentials = new Map<string, TeamCredentialRecord>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string, private readonly team: TeamStore) {
    this.path = join(vaultPath, 'team-auth.json')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<TeamAuthFile>
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.credentials)) throw new Error('团队登录凭据格式无效')
      this.credentials.clear()
      for (const record of raw.credentials) {
        if (!record || typeof record.memberId !== 'string' || typeof record.secretHash !== 'string'
          || !/^[a-f0-9]{64}$/.test(record.secretHash)) throw new Error('团队登录凭据数据无效')
        this.team.getMember(record.memberId)
        this.credentials.set(record.memberId, { ...record })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist()
    }
  }

  hasCredential(memberId: string): boolean {
    return this.credentials.has(memberId)
  }

  credentialKey(memberId: string): Buffer {
    const member = this.team.getMember(memberId)
    if (member.role !== 'member') throw new Error('账号类型无效')
    const record = this.credentials.get(memberId)
    if (!record) throw new Error('子账号尚未生成登录凭据')
    return Buffer.from(record.secretHash, 'hex')
  }

  async installCredential(memberId: string, secret: string): Promise<void> {
    const member = this.team.getMember(memberId)
    if (member.role !== 'member' || !member.enabled) throw new Error('邀请中的子账号不可用')
    if (!validSecret(secret)) throw new Error('邀请中的登录凭据无效')
    const now = new Date().toISOString()
    this.credentials.clear()
    this.credentials.set(memberId, {
      memberId,
      secretHash: hashSecret(secret).toString('hex'),
      createdAt: now,
      updatedAt: now
    })
    await this.persist()
  }

  async issue(actorId: string, memberId: string): Promise<TeamLoginCredential> {
    const actor = this.team.getMember(actorId)
    if (actor.role !== 'owner' || actor.id !== this.team.ownerId || !actor.enabled) throw new Error('只有主账号可以生成子账号登录凭据')
    const member = this.team.getMember(memberId)
    if (member.role !== 'member') throw new Error('主账号不需要子账号登录凭据')
    if (!member.enabled) throw new Error('已禁用子账号不能生成登录凭据')
    const secret = randomBytes(32).toString('base64url')
    const now = new Date().toISOString()
    const current = this.credentials.get(memberId)
    this.credentials.set(memberId, {
      memberId,
      secretHash: hashSecret(secret).toString('hex'),
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    })
    await this.persist()
    return { memberId, secret }
  }

  async revoke(actorId: string, memberId: string): Promise<void> {
    const actor = this.team.getMember(actorId)
    if (actor.role !== 'owner' || actor.id !== this.team.ownerId || !actor.enabled) throw new Error('只有主账号可以撤销子账号登录凭据')
    this.team.getMember(memberId)
    if (!this.credentials.delete(memberId)) return
    await this.persist()
  }

  authenticate(memberId: string, secret: string): TeamMember {
    const member = this.team.getMember(memberId)
    if (!member.enabled) throw new Error('当前子账号已被禁用')
    if (member.role !== 'member') throw new Error('登录账号类型无效')
    if (!validSecret(secret)) throw new Error('子账号登录凭据无效')
    const record = this.credentials.get(memberId)
    if (!record) throw new Error('子账号尚未生成登录凭据')
    const actual = hashSecret(secret)
    const expected = Buffer.from(record.secretHash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('子账号登录凭据错误')
    return member
  }

  private persist(): Promise<void> {
    const data: TeamAuthFile = { schemaVersion: 1, credentials: [...this.credentials.values()] }
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      const temporary = this.path + '.tmp'
      await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.writeQueue = operation
    return operation
  }
}
