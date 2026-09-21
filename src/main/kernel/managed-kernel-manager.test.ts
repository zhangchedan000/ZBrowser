import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
})
