import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FingerprintConfig,
  FingerprintRepairAuditRecord,
  IdentityConfigProvenance
} from '../shared/types'
import { normalizeIdentityConfigProvenance } from '../shared/identity-config-provenance'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'

interface FingerprintRepairCheckpoint {
  schemaVersion: 1
  auditId: string
  profileId: string
  createdAt: string
  fingerprint: FingerprintConfig
  identityConfigProvenance: IdentityConfigProvenance
}

const MAX_AUDIT_BYTES = 2 * 1024 * 1024

function checkpointName(): string {
  return 'fingerprint-repair-checkpoint.json'
}

function auditName(): string {
  return 'fingerprint-repair-audit.jsonl'
}

export class FingerprintRepairStateStore {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly logger?: Logger
  ) {}

  private checkpointPath(profileId: string): string {
    return join(this.profiles.profileRuntimePath(profileId), checkpointName())
  }

  private auditPath(profileId: string): string {
    return join(this.profiles.profileRuntimePath(profileId), auditName())
  }

  async createCheckpoint(
    profileId: string,
    auditId: string,
    fingerprint: FingerprintConfig,
    provenance: IdentityConfigProvenance | undefined
  ): Promise<void> {
    this.profiles.get(profileId)
    const directory = this.profiles.profileRuntimePath(profileId)
    await mkdir(directory, { recursive: true })
    const path = this.checkpointPath(profileId)
    const temporary = `${path}.${randomUUID()}.tmp`
    const checkpoint: FingerprintRepairCheckpoint = {
      schemaVersion: 1,
      auditId,
      profileId,
      createdAt: new Date().toISOString(),
      fingerprint: {
        ...fingerprint,
        disabledSpoofing: [...fingerprint.disabledSpoofing]
      },
      identityConfigProvenance: normalizeIdentityConfigProvenance(provenance)
    }
    try {
      await writeFile(temporary, JSON.stringify(checkpoint, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async checkpoint(profileId: string): Promise<FingerprintRepairCheckpoint | null> {
    this.profiles.get(profileId)
    let raw: string
    try {
      raw = await readFile(this.checkpointPath(profileId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('指纹修复备份损坏')
    }
    if (!value || typeof value !== 'object') throw new Error('指纹修复备份结构无效')
    const checkpoint = value as Partial<FingerprintRepairCheckpoint>
    if (checkpoint.schemaVersion !== 1
      || checkpoint.profileId !== profileId
      || typeof checkpoint.auditId !== 'string'
      || typeof checkpoint.createdAt !== 'string'
      || !checkpoint.fingerprint
      || typeof checkpoint.fingerprint !== 'object') {
      throw new Error('指纹修复备份字段无效')
    }
    return {
      schemaVersion: 1,
      auditId: checkpoint.auditId,
      profileId,
      createdAt: checkpoint.createdAt,
      fingerprint: checkpoint.fingerprint as FingerprintConfig,
      identityConfigProvenance: normalizeIdentityConfigProvenance(checkpoint.identityConfigProvenance)
    }
  }

  async clearCheckpoint(profileId: string): Promise<void> {
    await rm(this.checkpointPath(profileId), { force: true })
  }

  async appendAudit(record: FingerprintRepairAuditRecord): Promise<void> {
    this.profiles.get(record.profileId)
    const path = this.auditPath(record.profileId)
    await mkdir(this.profiles.profileRuntimePath(record.profileId), { recursive: true })
    try {
      if ((await stat(path)).size >= MAX_AUDIT_BYTES) {
        await rm(`${path}.previous`, { force: true })
        await rename(path, `${path}.previous`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async history(profileId: string, limit = 100): Promise<FingerprintRepairAuditRecord[]> {
    this.profiles.get(profileId)
    let raw: string
    try {
      raw = await readFile(this.auditPath(profileId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(200, limit)))
      .map((line) => {
        try {
          return JSON.parse(line) as FingerprintRepairAuditRecord
        } catch {
          this.logger?.error('忽略损坏的指纹修复审计记录', { profileId })
          return null
        }
      })
      .filter((record): record is FingerprintRepairAuditRecord => Boolean(record))
  }
}
