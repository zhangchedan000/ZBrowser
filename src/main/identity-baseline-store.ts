import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityBaseline, IdentityBaselineSnapshot } from '../shared/identity-baseline-model'
import type { IdentityConfigProvenance } from '../shared/types'

export type IdentityBaselineReplacementReason =
  | 'user_config'
  | 'kernel_upgrade'
  | 'kernel_rollback'
  | 'proxy_reassignment'

export interface IdentityBaselineReplacementRequest {
  requestedAt: string
  reasons: IdentityBaselineReplacementReason[]
}

interface IdentityBaselineFile {
  schemaVersion: 1 | 2
  current?: IdentityBaseline
  history: IdentityBaseline[]
  pendingReplacement?: IdentityBaselineReplacementRequest
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
        schemaVersion: 2,
        current: value.current,
        history: Array.isArray(value.history) ? value.history : [],
        pendingReplacement: value.pendingReplacement
          && typeof value.pendingReplacement.requestedAt === 'string'
          && Array.isArray(value.pendingReplacement.reasons)
          ? {
              requestedAt: value.pendingReplacement.requestedAt,
              reasons: value.pendingReplacement.reasons.filter((reason): reason is IdentityBaselineReplacementReason =>
                reason === 'user_config'
                || reason === 'kernel_upgrade'
                || reason === 'kernel_rollback'
                || reason === 'proxy_reassignment'
              )
            }
          : undefined
      }
    } catch {
      return { schemaVersion: 2, history: [] }
    }
  }

  private async write(profileId: string, data: IdentityBaselineFile): Promise<void> {
    await mkdir(join(this.rootPath, profileId), { recursive: true })
    const target = this.path(profileId)
    const temporary = `${target}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
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
    data.pendingReplacement = undefined
    data.schemaVersion = 2
    await this.write(profileId, data)
    return baseline
  }

  async requestReplacement(
    profileId: string,
    reason: IdentityBaselineReplacementReason
  ): Promise<IdentityBaselineReplacementRequest | null> {
    const data = await this.read(profileId)
    if (!data.current) return null

    const existing = data.pendingReplacement
    data.pendingReplacement = {
      requestedAt: existing?.requestedAt ?? new Date().toISOString(),
      reasons: [...new Set([...(existing?.reasons ?? []), reason])]
    }
    data.current.status = 'stale'
    data.current.updatedAt = new Date().toISOString()
    data.schemaVersion = 2
    await this.write(profileId, data)
    return data.pendingReplacement
  }

  async pendingReplacement(profileId: string): Promise<IdentityBaselineReplacementRequest | null> {
    return (await this.read(profileId)).pendingReplacement ?? null
  }

  async clearPendingReplacement(profileId: string): Promise<void> {
    const data = await this.read(profileId)
    if (!data.pendingReplacement) return
    data.pendingReplacement = undefined
    data.schemaVersion = 2
    await this.write(profileId, data)
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
