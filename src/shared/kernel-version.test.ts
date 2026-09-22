import { describe, expect, it } from 'vitest'
import { compareKernelVersions, isKernelDowngrade, latestKernelVersion, newerKernelVersion, validKernelVersion } from './kernel-version'

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

  it('rejects malformed versions', () => {
    expect(validKernelVersion('144.0.7559.132')).toBe(true)
    expect(validKernelVersion('144.0')).toBe(false)
    expect(() => compareKernelVersions('144.0', '145.0.0.0')).toThrow('内核版本号无效')
  })
})
