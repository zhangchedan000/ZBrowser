import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ManagedKernelRecord {
  id: string
  family: 'fingerprint-chromium' | 'custom'
  version: string
  platform: string
  executablePath: string
  installedAt: string
  sha256?: string
  enabled: boolean
}

interface KernelRegistryFile {
  schemaVersion: 1
  kernels: ManagedKernelRecord[]
}

function emptyRegistry(): KernelRegistryFile {
  return { schemaVersion: 1, kernels: [] }
}

function validRecord(value: unknown): value is ManagedKernelRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ManagedKernelRecord>
  return typeof record.id === 'string'
    && record.id.length > 0
    && record.id.length <= 160
    && (record.family === 'fingerprint-chromium' || record.family === 'custom')
    && typeof record.version === 'string'
    && /^\d+(?:\.\d+){3}$/.test(record.version)
    && typeof record.platform === 'string'
    && record.platform.length > 0
    && record.platform.length <= 64
    && typeof record.executablePath === 'string'
    && record.executablePath.length > 0
    && record.executablePath.length <= 4096
    && typeof record.installedAt === 'string'
    && Number.isFinite(Date.parse(record.installedAt))
    && (record.sha256 === undefined || (typeof record.sha256 === 'string' && /^[a-f\d]{64}$/i.test(record.sha256)))
    && typeof record.enabled === 'boolean'
}

function parseRegistry(raw: string): KernelRegistryFile {
  const value = JSON.parse(raw) as Partial<KernelRegistryFile>
  if (value.schemaVersion !== 1 || !Array.isArray(value.kernels) || !value.kernels.every(validRecord)) {
    throw new Error('内核注册表结构无效')
  }
  const ids = new Set<string>()
  for (const record of value.kernels) {
    if (ids.has(record.id)) throw new Error('内核注册表包含重复记录')
    ids.add(record.id)
  }
  return { schemaVersion: 1, kernels: value.kernels.map((record) => ({ ...record })) }
}

export class KernelRegistry {
  constructor(private readonly rootPath: string) {}

  private get filePath(): string {
    return join(this.rootPath, 'kernel-registry.json')
  }

  async list(): Promise<ManagedKernelRecord[]> {
    const registry = await this.load()
    return registry.kernels.map((record) => ({ ...record }))
  }

  async register(kernel: ManagedKernelRecord): Promise<void> {
    if (!validRecord(kernel)) throw new Error('内核注册记录无效')
    const registry = await this.load()
    const existing = registry.kernels.filter((item) => item.id !== kernel.id)
    registry.kernels = [...existing, { ...kernel }]
    await this.save(registry)
  }

  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !id || id.length > 160) throw new Error('内核注册标识无效')
    const registry = await this.load()
    registry.kernels = registry.kernels.filter((item) => item.id !== id)
    await this.save(registry)
  }

  private async load(): Promise<KernelRegistryFile> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
      throw error
    }

    try {
      return parseRegistry(raw)
    } catch {
      const quarantine = join(this.rootPath, `kernel-registry.corrupt-${Date.now()}.json`)
      await rename(this.filePath, quarantine).catch(() => undefined)
      return emptyRegistry()
    }
  }

  private async save(registry: KernelRegistryFile): Promise<void> {
    await mkdir(this.rootPath, { recursive: true })
    const tempPath = join(this.rootPath, `.kernel-registry-${process.pid}-${Date.now()}.tmp`)
    try {
      await writeFile(tempPath, JSON.stringify(registry, null, 2), { mode: 0o600 })
      await rename(tempPath, this.filePath)
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
  }
}
