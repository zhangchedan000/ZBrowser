import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from './defaults'
import { applyHardwareProfile } from './hardware-profiles'
import { buildRuntimeFingerprintChecks } from './runtime-fingerprint-diagnostics'
import type { EngineStatus, RuntimeFingerprintSnapshot } from './types'

const engine: EngineStatus = {
  executable: 'C:\\Chromium\\chrome.exe',
  source: 'profile',
  fingerprintKernel: true,
  label: 'Fingerprint Chromium',
  version: '144.0.7559.132'
}

function fixture() {
  const draft = defaultProfileDraft()
  draft.proxy = { protocol: 'direct', host: '', username: '', password: '' }
  draft.fingerprint = applyHardwareProfile({
    ...draft.fingerprint,
    language: 'en-US',
    acceptLanguages: 'en-US,en',
    timezone: 'America/New_York',
    networkIdentityMode: 'manual'
  }, 'windows-11-rtx4070')
  return draft
}

function runtime(): RuntimeFingerprintSnapshot {
  return {
    userAgent: 'Mozilla/5.0 Chrome/144.0.7559.132 Safari/537.36',
    platform: 'Win32',
    hardwareConcurrency: 16,
    deviceMemory: 8,
    devicePixelRatio: 1,
    screen: {
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1400,
      colorDepth: 24,
      pixelDepth: 24
    },
    language: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
    uaCh: {
      exposed: true,
      platform: 'Windows',
      mobile: false,
      brands: [{ brand: 'Chromium', version: '144' }],
      architecture: 'x86',
      bitness: '64',
      platformVersion: '10.0.0',
      fullVersionList: [{ brand: 'Chromium', version: '144.0.7559.132' }]
    }
  }
}

describe('runtime fingerprint diagnostics', () => {
  it('passes coherent browser-visible hardware, network and version surfaces', () => {
    const checks = buildRuntimeFingerprintChecks(fixture(), runtime(), engine)
    expect(checks.filter((check) => check.status === 'error')).toEqual([])
    expect(checks.find((check) => check.key === 'runtime-screen')?.status).toBe('pass')
    expect(checks.find((check) => check.key === 'runtime-ua-ch-version')?.status).toBe('pass')
  })

  it('flags hardware and timezone drift from the saved persona', () => {
    const observed = runtime()
    observed.hardwareConcurrency = 8
    observed.timezone = 'Asia/Tokyo'
    const checks = buildRuntimeFingerprintChecks(fixture(), observed, engine)

    expect(checks.find((check) => check.key === 'runtime-hardware-concurrency')?.status).toBe('error')
    expect(checks.find((check) => check.key === 'runtime-timezone')?.status).toBe('error')
  })

  it('treats hidden UA-CH as no stale high-entropy version surface', () => {
    const observed = runtime()
    observed.uaCh = { exposed: false, brands: [], fullVersionList: [] }
    const checks = buildRuntimeFingerprintChecks(fixture(), observed, engine)

    expect(checks.find((check) => check.key === 'runtime-ua-ch-version')?.status).toBe('pass')
    expect(checks.some((check) => check.key === 'runtime-ua-ch-architecture')).toBe(false)
  })
})
