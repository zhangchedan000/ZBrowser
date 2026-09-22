import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { locateBrowserForProfile } from './browser-locator'
import { SettingsStore } from './settings-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function installKernel(vault: string, version: string, source: 'release' | 'local-build') {
  const browserRoot = join(vault, 'kernels', version, 'browser')
  await mkdir(browserRoot, { recursive: true })
  const executable = join(browserRoot, process.platform === 'win32' ? 'chrome.exe' : 'chrome')
  await writeFile(executable, `test-browser-${version}`, { mode: 0o700 })
  await chmod(executable, 0o700)
  await writeFile(join(vault, 'kernels', version, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    version,
    assetName: 'test.zip',
    sha256: 'a'.repeat(64),
    installedAt: '2026-09-22T00:00:00.000Z',
    executableRelative: `browser/${process.platform === 'win32' ? 'chrome.exe' : 'chrome'}`,
    source,
    target: `${process.platform}-${process.arch}`
  }))
  return executable
}

async function fixture(source: 'release' | 'local-build') {
  const vault = await mkdtemp(join(tmpdir(), 'zbrowser-kernel-family-'))
  roots.push(vault)
  const version = '144.0.7559.132'
  const executable = await installKernel(vault, version, source)
  const settings = new SettingsStore(vault)
  await settings.initialize()
  return { vault, version, executable, settings }
}

describe('profile kernel family pinning', () => {
  it('accepts the matching family and rejects a same-version different family', async () => {
    const { vault, version, executable, settings } = await fixture('local-build')
    const custom = await locateBrowserForProfile(settings, vault, version, 'custom')
    expect(custom.executable).toBe(executable)
    expect(custom.source).toBe('profile')

    const release = await locateBrowserForProfile(settings, vault, version, 'fingerprint-chromium')
    expect(release.executable).toBeNull()
    expect(release.label).toContain('内核系列不匹配')
  })


  it('automatically selects only a newer patch in the pinned major', async () => {
    const { vault, version, settings } = await fixture('release')
    const newerPatch = '144.0.7559.150'
    const newerExecutable = await installKernel(vault, newerPatch, 'release')
    await installKernel(vault, '145.0.1.1', 'release')

    const resolved = await locateBrowserForProfile(settings, vault, version, 'fingerprint-chromium')
    expect(resolved.version).toBe(newerPatch)
    expect(resolved.executable).toBe(newerExecutable)
    expect(resolved.label).toContain('144 系列自动补丁')
  })

  it('never downgrades below the stored floor and never crosses a major automatically', async () => {
    const { vault, settings } = await fixture('release')
    await installKernel(vault, '144.0.7559.99', 'release')
    await installKernel(vault, '145.0.1.1', 'release')

    const aboveFloor = await locateBrowserForProfile(settings, vault, '144.0.7559.150', 'fingerprint-chromium')
    expect(aboveFloor.executable).toBeNull()
    expect(aboveFloor.version).toBe('144.0.7559.150')
  })

  it('ignores a newer same-major kernel from the wrong family', async () => {
    const { vault, version, executable, settings } = await fixture('release')
    await installKernel(vault, '144.0.7559.160', 'local-build')

    const resolved = await locateBrowserForProfile(settings, vault, version, 'fingerprint-chromium')
    expect(resolved.version).toBe(version)
    expect(resolved.executable).toBe(executable)
  })
})
