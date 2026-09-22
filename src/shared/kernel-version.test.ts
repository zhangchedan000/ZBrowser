import { describe, expect, it } from 'vitest'
import { compareKernelVersions, isKernelDowngrade, kernelFamilyForRelease, kernelMajorVersion, kernelReleaseMatchesPin, latestKernelVersion, latestSameMajorCompatibleKernelVersion, newerCompatibleKernelVersion, newerKernelVersion, sameKernelMajor, validKernelVersion } from './kernel-version'

describe('kernel version ordering', () => {
  it('compares all four Chromium version segments numerically', () => {
    expect(compareKernelVersions('144.0.7559.132', '144.0.7559.132')).toBe(0)
    expect(compareKernelVersions('145.0.1.1', '144.9.9999.999')).toBe(1)
    expect(compareKernelVersions('144.0.7559.99', '144.0.7559.132')).toBe(-1)
  })

  it('only treats an explicit lower pinned version as a downgrade', () => {
    expect(isKernelDowngrade('144.0.7559.132', '148.0.7778.215')).toBe(false)
    expect(isKernelDowngrade('148.0.7778.215', '144.0.7559.132')).toBe(true)
    expect(isKernelDowngrade('', '144.0.7559.132')).toBe(false)
    expect(isKernelDowngrade('148.0.7778.215', '')).toBe(false)
  })

  it('selects the newest valid upgrade without ever returning a downgrade', () => {
    expect(latestKernelVersion(['144.0.7559.132', '148.0.7778.215', '146.0.1.9'])).toBe('148.0.7778.215')
    expect(latestKernelVersion(['bad', ''])).toBeUndefined()
    expect(newerKernelVersion('144.0.7559.132', ['144.0.7559.99', '148.0.7778.215'])).toBe('148.0.7778.215')
    expect(newerKernelVersion('148.0.7778.215', ['144.0.7559.132', '148.0.7778.215'])).toBeUndefined()
    expect(newerKernelVersion('', ['148.0.7778.215'])).toBeUndefined()
  })

  it('matches pinned kernel family and only proposes compatible installed upgrades', () => {
    const releases = [
      { version: '144.0.7559.132', origin: 'release' as const, executable: 'C:/release-144/chrome.exe' },
      { version: '148.0.7778.215', origin: 'release' as const, executable: 'C:/release-148/chrome.exe' },
      { version: '149.0.1.1', origin: 'local-build' as const, executable: 'C:/custom-149/chrome.exe' },
      { version: '150.0.1.1', origin: 'release' as const, executable: undefined }
    ]

    expect(kernelFamilyForRelease(releases[0])).toBe('fingerprint-chromium')
    expect(kernelFamilyForRelease(releases[2])).toBe('custom')
    expect(kernelReleaseMatchesPin(releases[0], '144.0.7559.132', 'fingerprint-chromium')).toBe(true)
    expect(kernelReleaseMatchesPin(releases[0], '144.0.7559.132', 'custom')).toBe(false)
    expect(kernelReleaseMatchesPin(releases[3], '150.0.1.1', 'fingerprint-chromium')).toBe(false)
    expect(newerCompatibleKernelVersion('144.0.7559.132', 'fingerprint-chromium', releases)).toBe('148.0.7778.215')
    expect(newerCompatibleKernelVersion('149.0.1.1', 'custom', releases)).toBeUndefined()
  })

  it('locks automatic compatibility to the pinned major and never goes below the floor', () => {
    const releases = [
      { version: '144.0.7559.99', origin: 'release' as const, executable: 'C:/release-144-old/chrome.exe' },
      { version: '144.0.7559.132', origin: 'release' as const, executable: 'C:/release-144-current/chrome.exe' },
      { version: '144.0.7559.150', origin: 'release' as const, executable: 'C:/release-144-new/chrome.exe' },
      { version: '145.0.1.1', origin: 'release' as const, executable: 'C:/release-145/chrome.exe' },
      { version: '144.0.7559.160', origin: 'local-build' as const, executable: 'C:/custom-144/chrome.exe' }
    ]

    expect(kernelMajorVersion('144.0.7559.132')).toBe(144)
    expect(kernelMajorVersion('bad')).toBeUndefined()
    expect(sameKernelMajor('144.0.7559.132', '144.0.7559.150')).toBe(true)
    expect(sameKernelMajor('144.0.7559.132', '145.0.1.1')).toBe(false)
    expect(latestSameMajorCompatibleKernelVersion(
      '144.0.7559.132',
      'fingerprint-chromium',
      releases
    )).toBe('144.0.7559.150')
    expect(latestSameMajorCompatibleKernelVersion(
      '144.0.7559.150',
      'fingerprint-chromium',
      releases
    )).toBe('144.0.7559.150')
    expect(latestSameMajorCompatibleKernelVersion(
      '144.0.7559.151',
      'fingerprint-chromium',
      releases
    )).toBeUndefined()
  })

  it('rejects malformed versions', () => {
    expect(validKernelVersion('144.0.7559.132')).toBe(true)
    expect(validKernelVersion('144.0')).toBe(false)
    expect(() => compareKernelVersions('144.0', '145.0.0.0')).toThrow('内核版本号无效')
  })
})
