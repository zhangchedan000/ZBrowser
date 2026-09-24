import { resolve } from 'node:path'
import type { AppSettings, EngineStatus, KernelRelease } from '../../shared/types'
import type { Logger } from '../app-logger'
import { KernelManager } from '../kernel-manager'
import type { SettingsStore } from '../settings-store'
import { KernelRegistry, type ManagedKernelRecord } from './kernel-registry'

export class ManagedKernelManager extends KernelManager {
  constructor(
    vaultPath: string,
    private readonly managedSettings: SettingsStore,
    onProgress: ConstructorParameters<typeof KernelManager>[2],
    logger: Logger | undefined,
    kernelUsers: ConstructorParameters<typeof KernelManager>[4],
    private readonly registry: KernelRegistry
  ) {
    super(vaultPath, managedSettings, onProgress, logger, kernelUsers)
  }

  async initialize(): Promise<void> {
    await this.syncRegistry()
  }

  override async releases(): Promise<KernelRelease[]> {
    const [catalog, installed] = await Promise.all([super.releases(), super.installed()])
    const localBuilds = new Map(
      installed
        .filter((release) => release.origin === 'local-build')
        .map((release) => [release.version, release] as const)
    )
    const normalized: KernelRelease[] = []
    for (const release of catalog) {
      const localBuild = localBuilds.get(release.version)
      if (release.remoteAvailable && release.origin === 'local-build' && localBuild) {
        normalized.push({ ...release, installed: false, origin: 'release', executable: undefined })
        normalized.push(localBuild)
      } else {
        normalized.push(release)
      }
    }
    return normalized
  }

  override async install(version: string): Promise<EngineStatus> {
    const existing = (await super.installed()).find((release) => release.version === version)
    if (existing?.origin === 'local-build') {
      throw new Error(`版本 ${version} 已安装为自定义本地构建；为避免内核系列混用，请先移除该自定义内核，再安装 Fingerprint Chromium`)
    }
    const engine = await super.install(version)
    await this.syncRegistry()
    return engine
  }

  override async importLocal(selection: string): Promise<EngineStatus> {
    const engine = await super.importLocal(selection)
    await this.syncRegistry()
    return engine
  }

  override async activate(version: string): Promise<EngineStatus> {
    const engine = await super.activate(version)
    await this.syncRegistry()
    return engine
  }

  override async rollback(): Promise<EngineStatus> {
    const engine = await super.rollback()
    await this.syncRegistry()
    return engine
  }

  override async configure(
    patch: Pick<AppSettings, 'browserExecutable' | 'fingerprintKernel' | 'enginePreference'>,
    resolvedExecutable = patch.browserExecutable
  ): Promise<EngineStatus> {
    const engine = await super.configure(patch, resolvedExecutable)
    await this.syncRegistry()
    return engine
  }

  override async repair(version: string): Promise<EngineStatus> {
    const engine = await super.repair(version)
    await this.syncRegistry()
    return engine
  }

  override async remove(version: string): Promise<void> {
    await super.remove(version)
    await this.syncRegistry()
  }

  private async syncRegistry(): Promise<void> {
    const installed = await super.installed()
    const registered = await this.registry.list()
    const installedIds = new Set<string>()
    const configuredExecutable = this.managedSettings.get().browserExecutable
    const activeExecutable = configuredExecutable ? resolve(configuredExecutable) : undefined

    for (const release of installed) {
      if (!release.executable) continue
      const family: ManagedKernelRecord['family'] = release.origin === 'local-build'
        ? 'custom'
        : 'fingerprint-chromium'
      const id = `${family}-${release.version}`
      installedIds.add(id)
      await this.registry.register({
        id,
        family,
        version: release.version,
        platform: `${process.platform}-${process.arch}`,
        executablePath: release.executable,
        installedAt: release.publishedAt,
        sha256: release.sha256,
        enabled: activeExecutable === resolve(release.executable)
      })
    }

    for (const record of registered) {
      if (!installedIds.has(record.id)) await this.registry.remove(record.id)
    }
  }
}
