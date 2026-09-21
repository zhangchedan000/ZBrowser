import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

const EMPTY_REGISTRY: KernelRegistryFile = {
  schemaVersion: 1,
  kernels: []
}

export class KernelRegistry {
  constructor(private readonly rootPath: string) {}

  private get filePath(): string {
    return join(this.rootPath, 'kernel-registry.json')
  }

  async list(): Promise<ManagedKernelRecord[]> {
    const registry = await this.load()
    return registry.kernels
  }

  async register(kernel: ManagedKernelRecord): Promise<void> {
    const registry = await this.load()
    const existing = registry.kernels.filter((item) => item.id !== kernel.id)
    registry.kernels = [...existing, kernel]
    await this.save(registry)
  }

  async remove(id: string): Promise<void> {
    const registry = await this.load()
    registry.kernels = registry.kernels.filter((item) => item.id !== id)
    await this.save(registry)
  }

  private async load(): Promise<KernelRegistryFile> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as KernelRegistryFile
    } catch {
      return EMPTY_REGISTRY
    }
  }

  private async save(registry: KernelRegistryFile): Promise<void> {
    await mkdir(this.rootPath, { recursive: true })
    await writeFile(this.filePath, JSON.stringify(registry, null, 2), { mode: 0o600 })
  }
}
