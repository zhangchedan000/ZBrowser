import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelManager } from '../kernel-manager'
import { SettingsStore } from '../settings-store'
import { KernelRegistry } from './kernel-registry'
import { ManagedKernelManager } from './managed-kernel-manager'

const temporaryRoots: string[] = []

async function temporaryVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-managed-kernel-'))
  temporaryRoots.push(root)
  return join(root, 'vault')
}

async function writeKernel(
  vaultPath: string,
  version: string,
  source: 'release' | 'local-build',
  sha256: string
): Promise<string> {
  const root = join(vaultPath, 'kernels', version)
  const browserRoot = join(root, 'browser')
  const executable = join(browserRoot, 'chrome.exe')
  await mkdir(browserRoot, { recursive: true })
  await writeFile(executable, 'test-browser-binary')
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    version,
    assetName: source === 'release' ? `fingerprint-chromium-${version}.zip` : `local-build-${process.platform}-${process.arch}`,
    sha256,
    installedAt: '2026-09-21T00:00:00.000Z',
    executableRelative: 'browser/chrome.exe',
    source,
    target: `${process.platform}-${process.arch}`
  }, null, 2))
  return executable
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('ManagedKernelManager registry synchronization', () => {
  it('registers installed families, tracks the active kernel, and removes stale records', async () => {
    const vaultPath = await temporaryVault()
    const releaseVersion = '144.0.7559.132'
    const customVersion = '145.0.0.1'
    const releaseSha = 'a'.repeat(64)
    const customSha = 'b'.repeat(64)
    const releaseExecutable = await writeKernel(vaultPath, releaseVersion, 'release', releaseSha)
    const customExecutable = await writeKernel(vaultPath, customVersion, 'local-build', customSha)

    const settings = new SettingsStore(vaultPath)
    await settings.update({
      browserExecutable: releaseExecutable,
      fingerprintKernel: true,
      enginePreference: 'auto'
    })
    const registry = new KernelRegistry(join(vaultPath, 'kernels'))
    await registry.register({
      id: 'fingerprint-chromium-143.0.0.1',
      family: 'fingerprint-chromium',
      version: '143.0.0.1',
      platform: `${process.platform}-${process.arch}`,
      executablePath: join(vaultPath, 'kernels', '143.0.0.1', 'browser', 'chrome.exe'),
      installedAt: '2026-09-20T00:00:00.000Z',
      enabled: false
    })

    const manager = new ManagedKernelManager(
      vaultPath,
      settings,
      () => undefined,
      undefined,
      () => [],
      registry
    )

    await manager.initialize()
    let records = await registry.list()
    expect(records).toHaveLength(2)
    expect(records.find((record) => record.id === `fingerprint-chromium-${releaseVersion}`)).toMatchObject({
      family: 'fingerprint-chromium',
      version: releaseVersion,
      sha256: releaseSha,
      enabled: true
    })
    expect(records.find((record) => record.id === `custom-${customVersion}`)).toMatchObject({
      family: 'custom',
      version: customVersion,
      sha256: customSha,
      enabled: false
    })
    expect(records.some((record) => record.version === '143.0.0.1')).toBe(false)

    const externalRoot = join(vaultPath, 'external-browser')
    const externalExecutable = join(externalRoot, 'chrome.exe')
    await mkdir(externalRoot, { recursive: true })
    await writeFile(externalExecutable, 'external-browser-binary')
    await manager.configure({
      browserExecutable: externalExecutable,
      fingerprintKernel: false,
      enginePreference: 'auto'
    })
    records = await registry.list()
    expect(records.find((record) => record.id === `fingerprint-chromium-${releaseVersion}`)?.enabled).toBe(false)
    expect(records.find((record) => record.id === `custom-${customVersion}`)?.enabled).toBe(false)

    await settings.update({ browserExecutable: customExecutable })
    await manager.initialize()
    records = await registry.list()
    expect(records.find((record) => record.id === `fingerprint-chromium-${releaseVersion}`)?.enabled).toBe(false)
    expect(records.find((record) => record.id === `custom-${customVersion}`)?.enabled).toBe(true)

    await rm(join(vaultPath, 'kernels', customVersion), { recursive: true, force: true })
    await manager.initialize()
    records = await registry.list()
    expect(records.map((record) => record.id)).toEqual([`fingerprint-chromium-${releaseVersion}`])
  })

  it('keeps same-version custom builds separate from upstream releases', async () => {
    const vaultPath = await temporaryVault()
    const version = '144.0.7559.132'
    const settings = new SettingsStore(vaultPath)
    const registry = new KernelRegistry(join(vaultPath, 'kernels'))
    const manager = new ManagedKernelManager(vaultPath, settings, () => undefined, undefined, () => [], registry)
    const localBuild = {
      version,
      publishedAt: '2026-09-21T00:00:00.000Z',
      assetName: 'local-build-win32-x64',
      downloadUrl: '',
      size: 0,
      sha256: 'b'.repeat(64),
      installed: true,
      remoteAvailable: false,
      origin: 'local-build' as const,
      executable: join(vaultPath, 'kernels', version, 'browser', 'chrome.exe')
    }
    const upstream = {
      version,
      publishedAt: '2026-02-01T00:00:00.000Z',
      assetName: 'ungoogled-chromium.zip',
      downloadUrl: 'https://github.com/adryfish/fingerprint-chromium/releases/download/144.0.7559.132/ungoogled-chromium.zip',
      size: 100_000_000,
      sha256: 'a'.repeat(64),
      installed: true,
      remoteAvailable: true,
      origin: 'local-build' as const,
      executable: localBuild.executable
    }
    const installedSpy = vi.spyOn(KernelManager.prototype, 'installed').mockResolvedValue([localBuild])
    const releasesSpy = vi.spyOn(KernelManager.prototype, 'releases').mockResolvedValue([upstream])
    const installSpy = vi.spyOn(KernelManager.prototype, 'install')

    try {
      await expect(manager.releases()).resolves.toEqual([
        expect.objectContaining({ version, origin: 'release', installed: false, remoteAvailable: true, executable: undefined }),
        localBuild
      ])
      await expect(manager.install(version)).rejects.toThrow('自定义本地构建')
      expect(installSpy).not.toHaveBeenCalled()
    } finally {
      installedSpy.mockRestore()
      releasesSpy.mockRestore()
      installSpy.mockRestore()
    }
  })
})
