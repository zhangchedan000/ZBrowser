import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityBaseline, IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import type { IdentityConfigProvenance } from '../shared/types'

interface IdentityBaselineFile {
  schemaVersion: 1
  current?: IdentityBaseline
  history: IdentityBaseline[]
}

export class IdentityBaselineStore {
  constructor(private readonly rootPath: string) {}

  private path(profileId: string): string {
    return join(this.rootPath, profileId, 'identity-baseline.json')
  }

  private async read(profileId: string): Promise<IdentityBaselineFile> {
    try {
      const raw = await readFile(this.path(profileId), 'utf8')
      const value = JSON.parse(raw) as IdentityBaselineFile
      return {
        schemaVersion: 1,
        current: value.current,
        history: Array.isArray(value.history) ? value.history : []
      }
    } catch {
      return { schemaVersion: 1, history: [] }
    }
  }

  private async write(profileId: string, data: IdentityBaselineFile): Promise<void> {
    await mkdir(join(this.rootPath, profileId), { recursive: true })
    await writeFile(this.path(profileId), JSON.stringify(data, null, 2), 'utf8')
  }

  async create(
    profileId: string,
    snapshot: IdentityBaselineSnapshot,
    provenance: IdentityConfigProvenance
  ): Promise<IdentityBaseline> {
    const data = await this.read(profileId)
    const now = new Date().toISOString()
    if (data.current) {
      data.current.status = 'replaced'
      data.history.push(data.current)
    }
    const baseline: IdentityBaseline = {
      id: randomUUID(),
      profileId,
      version: (data.current?.version ?? 0) + 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: now,
      snapshot,
      identityConfigProvenance: provenance
    }
    data.current = baseline
    await this.write(profileId, data)
    return baseline
  }

  async get(profileId: string): Promise<IdentityBaseline | null> {
    return (await this.read(profileId)).current ?? null
  }

  async history(profileId: string): Promise<IdentityBaseline[]> {
    return (await this.read(profileId)).history
  }

  async markStale(profileId: string): Promise<IdentityBaseline | null> {
    const data = await this.read(profileId)
    if (!data.current) return null
    data.current.status = 'stale'
    data.current.updatedAt = new Date().toISOString()
    await this.write(profileId, data)
    return data.current
  }

  async markVerified(profileId: string): Promise<IdentityBaseline | null> {
    const data = await this.read(profileId)
    if (!data.current) return null
    const now = new Date().toISOString()
    data.current.status = 'active'
    data.current.lastVerifiedAt = now
    data.current.updatedAt = now
    await this.write(profileId, data)
    return data.current
  }
}
