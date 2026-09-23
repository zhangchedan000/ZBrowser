import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityHealthTrendRecord } from '../shared/identity-health-trend'

const MAX_RECORDS = 100

function validRecord(value: unknown): value is IdentityHealthTrendRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<IdentityHealthTrendRecord>
  return typeof item.checkedAt === 'string'
    && Number.isFinite(Date.parse(item.checkedAt))
    && typeof item.baselineId === 'string'
    && Number.isFinite(item.score)
    && ['low', 'medium', 'high', 'critical'].includes(item.risk ?? '')
    && typeof item.driftDetected === 'boolean'
    && ['low', 'medium', 'high', 'critical'].includes(item.driftSeverity ?? '')
    && Number.isInteger(item.changeCount)
}

export class IdentityHealthHistoryStore {
  private readonly root: string

  constructor(vaultPath: string) {
    this.root = join(vaultPath, 'identity-health-history')
  }

  private file(profileId: string): string {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(profileId)) throw new Error('环境 ID 无效')
    return join(this.root, `${profileId}.json`)
  }

  async list(profileId: string): Promise<IdentityHealthTrendRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file(profileId), 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(validRecord).slice(-MAX_RECORDS).reverse()
    } catch {
      return []
    }
  }

  async record(
    profileId: string,
    record: IdentityHealthTrendRecord
  ): Promise<IdentityHealthTrendRecord[]> {
    const existing = (await this.list(profileId)).reverse()
    const next = [...existing, record].slice(-MAX_RECORDS)
    await mkdir(this.root, { recursive: true })
    const path = this.file(profileId)
    const temporary = `${path}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
    return [...next].reverse()
  }
}
