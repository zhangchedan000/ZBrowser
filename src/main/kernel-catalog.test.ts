import { describe, expect, it } from 'vitest'
import type { EngineStatus, KernelRelease } from '../shared/types'
import { mergeKernelCatalog } from './kernel-catalog'

const VERSION = '144.0.7559.132'

function managedRelease(origin: KernelRelease['origin'], executable: string): KernelRelease {
  return {
    version: VERSION,
    publishedAt: '2026-09-01T00:00:00.000Z',
    assetName: origin === 'local-build' ? 'local-build' : 'release.zip',
    downloadUrl: '',
    size: 1,
    sha256: 'a'.repeat(64),
    installed: true,
    remoteAvailable: origin !== 'local-build',
    origin,
    executable
  }
}

const bundled: EngineStatus = {
  executable: 'C:\\bundled\\chrome.exe',
  source: 'bundled',
  fingerprintKernel: true,
  label: 'bundled',
  version: VERSION
}

describe('mergeKernelCatalog kernel identity', () => {
  it('keeps a custom build alongside a bundled fingerprint kernel with the same version', () => {
    const merged = mergeKernelCatalog([
      managedRelease('release', 'C:\\managed-release\\chrome.exe'),
      managedRelease('local-build', 'C:\\custom\\chrome.exe')
    ], [bundled])

    expect(merged).toHaveLength(2)
    expect(merged).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'bundled', executable: bundled.executable }),
      expect.objectContaining({ origin: 'local-build', executable: 'C:\\custom\\chrome.exe' })
    ]))
  })

  it('lets the bundled copy replace only the managed fingerprint copy at the same version', () => {
    const merged = mergeKernelCatalog([
      managedRelease('release', 'C:\\managed-release\\chrome.exe')
    ], [bundled])

    expect(merged).toEqual([
      expect.objectContaining({ origin: 'bundled', executable: bundled.executable })
    ])
  })
})
