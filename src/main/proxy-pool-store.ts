import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ProxyCheckSummary,
  ProxyConfig,
  ProxyPoolEntry,
  ProxyPoolEntryInput,
  ProxyPoolHealth,
  ProxyPoolStats,
  ProxyTestResult
} from '../shared/types'
import { validateProxyConfig } from '../shared/validation'
import { identitySecretCodec, type SecretCodec } from './secret-codec'
import { privateProxyConfig, sameProxyIdentity } from './profile-secrets'
import { testProxy } from './proxy-tester'

interface StoredStats {
  checks: number
  successes: number
  consecutiveFailures: number
  latencyTotalMs: number
  lastCheckedAt?: string
  lastSuccessAt?: string
  lastFailureAt?: string
}

interface StoredEntry {
  id: string
  name: string
  tags: string[]
  proxy: ProxyConfig
  createdAt: string
  updatedAt: string
  check?: ProxyCheckSummary
  quarantined: boolean
  stats: StoredStats
}

interface PoolFile {
  schemaVersion: 1
  entries: StoredEntry[]
}

type ProxyTester = (config: ProxyConfig) => Promise<ProxyTestResult>

const MAX_ENTRIES = 2000
const QUARANTINE_AFTER_FAILURES = 3

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('代理名称格式无效')
  const name = value.trim()
  if (!name) throw new Error('代理名称不能为空')
  if (name.length > 80) throw new Error('代理名称不能超过 80 个字符')
  return name
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) throw new Error('代理标签格式无效')
  const tags = [...new Set(value.map((tag) => tag.trim()).filter(Boolean))]
  if (tags.length > 20 || tags.some((tag) => tag.length > 30)) throw new Error('最多设置 20 个代理标签，每个不超过 30 个字符')
  return tags
}

function safeDate(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

function safeCheck(value: unknown): ProxyCheckSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const check = value as Partial<ProxyCheckSummary>
  const checkedAt = safeDate(check.checkedAt)
  if (typeof check.ok !== 'boolean' || typeof check.latencyMs !== 'number' || !checkedAt) return undefined
  return { ...check, latencyMs: Math.max(0, Math.round(check.latencyMs)), checkedAt } as ProxyCheckSummary
}

function safeStats(value: unknown): StoredStats {
  const stats = value && typeof value === 'object' ? value as Partial<StoredStats> : {}
  const checks = Number.isInteger(stats.checks) && Number(stats.checks) >= 0 ? Number(stats.checks) : 0
  const successes = Number.isInteger(stats.successes) && Number(stats.successes) >= 0 ? Math.min(Number(stats.successes), checks) : 0
  return {
    checks,
    successes,
    consecutiveFailures: Number.isInteger(stats.consecutiveFailures) && Number(stats.consecutiveFailures) >= 0 ? Number(stats.consecutiveFailures) : 0,
    latencyTotalMs: typeof stats.latencyTotalMs === 'number' && Number.isFinite(stats.latencyTotalMs) && stats.latencyTotalMs >= 0 ? stats.latencyTotalMs : 0,
    lastCheckedAt: safeDate(stats.lastCheckedAt),
    lastSuccessAt: safeDate(stats.lastSuccessAt),
    lastFailureAt: safeDate(stats.lastFailureAt)
  }
}

function publicStats(stats: StoredStats): ProxyPoolStats {
  return {
    checks: stats.checks,
    successes: stats.successes,
    consecutiveFailures: stats.consecutiveFailures,
    successRate: stats.checks ? Math.round((stats.successes / stats.checks) * 1000) / 1000 : 0,
    averageLatencyMs: stats.successes ? Math.round(stats.latencyTotalMs / stats.successes) : undefined,
    lastCheckedAt: stats.lastCheckedAt,
    lastSuccessAt: stats.lastSuccessAt,
    lastFailureAt: stats.lastFailureAt
  }
}

function healthFor(entry: StoredEntry): ProxyPoolHealth {
  if (!entry.stats.checks || !entry.check) return 'unchecked'
  if (entry.quarantined) return 'quarantined'
  if (!entry.check.ok) return 'failed'
  const stats = publicStats(entry.stats)
  if (entry.check.degraded || entry.check.geoConfidence === 'conflict' || stats.successRate < 0.8 || (stats.averageLatencyMs ?? 0) > 1500) return 'degraded'
  return 'healthy'
}

function scoreFor(entry: StoredEntry): number {
  if (!entry.stats.checks || entry.quarantined || !entry.check?.ok) return 0
  const stats = publicStats(entry.stats)
  const success = stats.successRate * 70
  const latency = stats.averageLatencyMs ?? 3000
  const latencyScore = Math.max(0, 30 * (1 - Math.min(latency, 3000) / 3000))
  const penalties = (entry.check.degraded ? 10 : 0) + (entry.check.geoConfidence === 'conflict' ? 30 : 0)
  return Math.max(0, Math.min(100, Math.round(success + latencyScore - penalties)))
}

export class ProxyPoolStore {
  readonly path: string
  readonly backupPath: string
  private entries = new Map<string, StoredEntry>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    vaultPath: string,
    private readonly secrets: SecretCodec = identitySecretCodec,
    private readonly tester: ProxyTester = testProxy
  ) {
    this.path = join(vaultPath, 'proxy-pool.json')
    this.backupPath = join(vaultPath, 'proxy-pool.json.backup')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    let loaded: StoredEntry[] | undefined
    for (const candidate of [this.path, this.backupPath]) {
      try {
        loaded = await this.read(candidate)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
      }
    }
    this.entries.clear()
    for (const entry of loaded ?? []) this.entries.set(entry.id, entry)
    await this.persist()
  }

  list(): ProxyPoolEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((entry) => this.publicEntry(entry))
  }

  get(id: string): ProxyPoolEntry {
    return this.publicEntry(this.internal(id))
  }

  proxyConfig(id: string): ProxyConfig {
    return { ...this.internal(id).proxy }
  }

  check(id: string): ProxyCheckSummary | undefined {
    const check = this.internal(id).check
    return check ? { ...check } : undefined
  }

  async create(input: ProxyPoolEntryInput): Promise<ProxyPoolEntry> {
    if (this.entries.size >= MAX_ENTRIES) throw new Error(`代理池最多保存 ${MAX_ENTRIES} 个代理`)
    const proxy = validateProxyConfig(input.proxy)
    if (proxy.protocol === 'direct') throw new Error('代理池不能保存直连配置')
    this.assertUniqueProxy(undefined, proxy)
    const now = new Date().toISOString()
    const entry: StoredEntry = {
      id: randomUUID(),
      name: normalizeName(input.name),
      tags: normalizeTags(input.tags),
      proxy: privateProxyConfig(proxy),
      createdAt: now,
      updatedAt: now,
      quarantined: false,
      stats: { checks: 0, successes: 0, consecutiveFailures: 0, latencyTotalMs: 0 }
    }
    this.entries.set(entry.id, entry)
    await this.persist()
    return this.publicEntry(entry)
  }

  async update(id: string, input: ProxyPoolEntryInput): Promise<ProxyPoolEntry> {
    const current = this.internal(id)
    const candidate = validateProxyConfig(input.proxy)
    if (candidate.protocol === 'direct') throw new Error('代理池不能保存直连配置')
    const keepStoredPassword = !candidate.password
      && candidate.passwordStored
      && sameProxyIdentity(current.proxy, candidate)
    const proxy = privateProxyConfig({
      ...candidate,
      password: keepStoredPassword ? current.proxy.password : candidate.password
    })
    this.assertUniqueProxy(id, proxy)
    const same = sameProxyIdentity(current.proxy, proxy) && current.proxy.password === proxy.password
    const next: StoredEntry = {
      ...current,
      name: normalizeName(input.name),
      tags: normalizeTags(input.tags),
      proxy: privateProxyConfig(proxy),
      updatedAt: new Date().toISOString(),
      ...(same ? {} : {
        check: undefined,
        quarantined: false,
        stats: { checks: 0, successes: 0, consecutiveFailures: 0, latencyTotalMs: 0 }
      })
    }
    this.entries.set(id, next)
    await this.persist()
    return this.publicEntry(next)
  }

  async remove(id: string): Promise<void> {
    this.internal(id)
    this.entries.delete(id)
    await this.persist()
  }

  async test(id: string): Promise<ProxyPoolEntry> {
    const entry = this.internal(id)
    const startedProxy = { ...entry.proxy }
    const result = await this.tester(startedProxy)
    const current = this.internal(id)
    if (!sameProxyIdentity(startedProxy, current.proxy) || startedProxy.password !== current.proxy.password) {
      throw new Error('检测期间代理配置已变更，本次结果未保存')
    }
    return this.recordResult(id, result)
  }

  async recordResult(id: string, result: ProxyTestResult): Promise<ProxyPoolEntry> {
    const current = this.internal(id)
    const now = new Date().toISOString()
    const ok = result.ok === true
    const stats: StoredStats = {
      ...current.stats,
      checks: current.stats.checks + 1,
      successes: current.stats.successes + (ok ? 1 : 0),
      consecutiveFailures: ok ? 0 : current.stats.consecutiveFailures + 1,
      latencyTotalMs: current.stats.latencyTotalMs + (ok ? Math.max(0, result.latencyMs) : 0),
      lastCheckedAt: now,
      lastSuccessAt: ok ? now : current.stats.lastSuccessAt,
      lastFailureAt: ok ? current.stats.lastFailureAt : now
    }
    const next: StoredEntry = {
      ...current,
      check: { ...result, checkedAt: now },
      stats,
      quarantined: ok ? false : stats.consecutiveFailures >= QUARANTINE_AFTER_FAILURES,
      updatedAt: now
    }
    this.entries.set(id, next)
    await this.persist()
    return this.publicEntry(next)
  }

  async testMany(idsInput?: string[]): Promise<ProxyPoolEntry[]> {
    const ids = idsInput?.length ? [...new Set(idsInput)] : [...this.entries.keys()]
    if (ids.length > MAX_ENTRIES) throw new Error('批量检测数量超出限制')
    for (const id of ids) this.internal(id)
    const results = new Map<string, ProxyPoolEntry>()
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, Math.max(1, ids.length)) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]
        results.set(id, await this.test(id))
      }
    })
    await Promise.all(workers)
    return ids.map((id) => results.get(id)!)
  }

  private internal(id: string): StoredEntry {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('代理 ID 无效')
    const entry = this.entries.get(id)
    if (!entry) throw new Error('代理不存在')
    return entry
  }

  private assertUniqueProxy(id: string | undefined, proxy: ProxyConfig): void {
    const conflict = [...this.entries.values()].find((entry) => entry.id !== id && sameProxyIdentity(entry.proxy, proxy))
    if (conflict) throw new Error(`该代理配置已存在：${conflict.name}`)
  }

  private publicEntry(entry: StoredEntry): ProxyPoolEntry {
    return {
      id: entry.id,
      name: entry.name,
      tags: [...entry.tags],
      proxy: {
        ...entry.proxy,
        password: '',
        passwordStored: Boolean(entry.proxy.password)
      },
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      check: entry.check ? { ...entry.check } : undefined,
      health: healthFor(entry),
      score: scoreFor(entry),
      stats: publicStats(entry.stats),
      assignedProfileIds: []
    }
  }

  private async read(path: string): Promise<StoredEntry[]> {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<PoolFile>
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) throw new Error('代理池数据格式无效')
    if (raw.entries.length > MAX_ENTRIES) throw new Error('代理池数据超过数量限制')
    const ids = new Set<string>()
    const entries: StoredEntry[] = []
    for (const value of raw.entries) {
      const stored = value as Partial<StoredEntry>
      if (typeof stored.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(stored.id) || ids.has(stored.id)) throw new Error('代理池包含无效或重复 ID')
      if (!stored.proxy || typeof stored.proxy.password !== 'string') throw new Error('代理池配置不完整')
      const proxy = validateProxyConfig({ ...stored.proxy, password: this.secrets.decode(stored.proxy.password) })
      if (proxy.protocol === 'direct') throw new Error('代理池不能包含直连配置')
      if (entries.some((entry) => sameProxyIdentity(entry.proxy, proxy))) throw new Error('代理池包含重复代理')
      const createdAt = safeDate(stored.createdAt)
      const updatedAt = safeDate(stored.updatedAt)
      if (!createdAt || !updatedAt) throw new Error('代理池时间字段无效')
      ids.add(stored.id)
      entries.push({
        id: stored.id,
        name: normalizeName(stored.name),
        tags: normalizeTags(stored.tags ?? []),
        proxy: privateProxyConfig(proxy),
        createdAt,
        updatedAt,
        check: safeCheck(stored.check),
        quarantined: stored.quarantined === true,
        stats: safeStats(stored.stats)
      })
    }
    return entries
  }

  private persist(): Promise<void> {
    const data: PoolFile = {
      schemaVersion: 1,
      entries: [...this.entries.values()].map((entry) => ({
        ...entry,
        proxy: { ...entry.proxy, password: this.secrets.encode(entry.proxy.password) }
      }))
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
        await rm(backupTemporary, { force: true }).catch(() => undefined)
      }
    })
    this.writeQueue = operation
    return operation
  }
}
