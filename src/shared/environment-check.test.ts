import { describe, expect, it } from 'vitest'
import type { BrowserProfileView, EngineStatus } from './types'
import { buildEnvironmentChecks, environmentCheckSummary } from './environment-check'

function profile(overrides: Partial<BrowserProfileView> = {}): BrowserProfileView {
  return {
    id: 'test-profile',
    serialNumber: 1,
    name: 'US profile',
    note: '',
    group: '',
    tags: [],
    extensionIds: [],
    color: '#1677ff',
    startUrls: [],
    kernelVersion: '',
    window: { mode: 'auto', x: 0, y: 0, width: 1280, height: 720 },
    favorite: false,
    proxy: { protocol: 'http', host: 'proxy.example.com', port: 8080, username: '', password: '', passwordStored: false },
    fingerprint: {
      seed: 123456,
      hardwareProfileId: 'windows-11-rtx4060',
      platform: 'windows',
      platformVersion: '10.0.0',
      brand: 'Chrome',
      brandVersion: '',
      hardwareConcurrency: 12,
      language: 'en-US',
      acceptLanguages: 'en-US,en',
      timezone: 'America/Los_Angeles',
      webrtcPolicy: 'proxy_only',
      networkIdentityMode: 'proxy',
      proxyExitPolicy: 'block',
      screenWidth: 1920,
      screenHeight: 1080,
      disabledSpoofing: []
    },
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    proxyCheck: {
      ok: true,
      ip: '203.0.113.10',
      latencyMs: 80,
      countryCode: 'US',
      country: 'United States',
      city: 'Los Angeles',
      timezone: 'America/Los_Angeles',
      latitude: 34.05,
      longitude: -118.24,
      checkedAt: new Date().toISOString()
    },
    status: 'closed',
    ...overrides
  }
}

const engine: EngineStatus = {
  executable: 'C:\\Chromium\\chrome.exe',
  source: 'bundled',
  fingerprintKernel: true,
  label: 'Fingerprint Chromium',
  version: '144.0.7559.0'
}

describe('environment consistency checks', () => {
  it('accepts a coherent US proxy profile', () => {
    const checks = buildEnvironmentChecks(profile(), engine)
    const summary = environmentCheckSummary(checks)
    expect(summary.errors).toBe(0)
    expect(checks.find((item) => item.key === 'webrtc')?.level).toBe('ok')
    expect(checks.find((item) => item.key === 'timezone')?.level).toBe('ok')
    expect(checks.find((item) => item.key === 'language')?.level).toBe('ok')
  })

  it('warns when manual locale and WebRTC conflict with a US proxy', () => {
    const input = profile()
    input.fingerprint = {
      ...input.fingerprint,
      networkIdentityMode: 'manual',
      language: 'zh-CN',
      acceptLanguages: 'zh-CN,zh',
      timezone: 'Asia/Shanghai',
      webrtcPolicy: 'default'
    }
    const checks = buildEnvironmentChecks(input, engine)
    expect(checks.find((item) => item.key === 'timezone')?.level).toBe('warning')
    expect(checks.find((item) => item.key === 'language')?.level).toBe('warning')
    expect(checks.find((item) => item.key === 'webrtc')?.level).toBe('warning')
  })
})
