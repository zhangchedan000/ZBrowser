import { describe, expect, it } from 'vitest'
import type { ProxyCheckSummary, RuntimeFingerprintSnapshot } from './types'
import { compareIdentityBaseline } from './identity-drift-engine'
import { buildRuntimeIdentitySnapshot } from './runtime-identity-snapshot'

function runtimeSnapshot(): RuntimeFingerprintSnapshot {
  return {
    userAgent: 'Mozilla/5.0 Chrome/144.0.7559.132',
    platform: 'Win32',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    devicePixelRatio: 1.25,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
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
    },
    webgl: {
      available: true,
      vendor: 'WebKit',
      renderer: 'WebKit WebGL',
      unmaskedVendor: 'NVIDIA Corporation',
      unmaskedRenderer: 'NVIDIA GeForce RTX 4060'
    },
    webgpu: {
      available: true,
      vendor: 'nvidia',
      architecture: 'ada',
      device: '0x2882'
    },
    systemGpu: {
      devices: [{
        vendorString: 'NVIDIA',
        deviceString: 'NVIDIA GeForce RTX 4060',
        driverVendor: 'NVIDIA',
        driverVersion: '32.0'
      }],
      glVendor: 'Google Inc. (NVIDIA)',
      glRenderer: 'ANGLE (NVIDIA GeForce RTX 4060)',
      featureStatus: { gpu_compositing: 'enabled' }
    },
    fonts: {
      method: 'canvas-metric-v1',
      checked: ['Segoe UI Emoji', 'Consolas', 'Segoe UI'],
      detected: ['Segoe UI Emoji', 'Consolas', 'Segoe UI']
    }
  }
}

const network: ProxyCheckSummary = {
  ok: true,
  ip: '203.0.113.10',
  ipVersion: 4,
  latencyMs: 42,
  country: 'United States',
  countryCode: 'US',
  region: 'New York',
  city: 'New York',
  timezone: 'America/New_York',
  asn: 64500,
  organization: 'Example ISP',
  isp: 'Example ISP',
  geoConfidence: 'consensus',
  checkedAt: '2026-09-23T08:00:00.000Z'
}

describe('runtime identity snapshot adapter', () => {
  it('normalizes existing runtime observations into the baseline snapshot shape', () => {
    const result = buildRuntimeIdentitySnapshot({
      runtime: runtimeSnapshot(),
      engine: { fingerprintKernel: true, version: '144.0.7559.132' },
      network,
      capturedAt: '2026-09-23T08:30:00.000Z'
    })

    expect(result.capturedAt).toBe('2026-09-23T08:30:00.000Z')
    expect(result.snapshot.browser).toMatchObject({
      platform: 'Win32',
      kernelVersion: '144.0.7559.132'
    })
    expect(result.snapshot.hardware).toMatchObject({
      hardwareConcurrency: 8,
      deviceMemory: 8,
      devicePixelRatio: 1.25
    })
    expect(result.snapshot.gpu).toMatchObject({
      webgl: {
        unmaskedVendor: 'NVIDIA Corporation',
        unmaskedRenderer: 'NVIDIA GeForce RTX 4060'
      },
      webgpu: {
        vendor: 'nvidia',
        architecture: 'ada'
      }
    })
    expect(result.snapshot.rendering).toEqual({
      fonts: {
        method: 'canvas-metric-v1',
        detected: ['Consolas', 'Segoe UI', 'Segoe UI Emoji']
      }
    })
    expect(result.snapshot.network).toMatchObject({
      ip: '203.0.113.10',
      countryCode: 'US',
      timezone: 'America/New_York'
    })
    expect(result.snapshot.network).not.toHaveProperty('latencyMs')
    expect(result.snapshot.network).not.toHaveProperty('checkedAt')
    expect(result.snapshot.locale).toEqual({
      language: 'en-US',
      languages: ['en-US', 'en'],
      timezone: 'America/New_York'
    })
  })

  it('does not promote a failed proxy observation into identity state', () => {
    const result = buildRuntimeIdentitySnapshot({
      runtime: runtimeSnapshot(),
      network: {
        ok: false,
        latencyMs: 1000,
        error: 'timeout',
        checkedAt: '2026-09-23T08:00:00.000Z'
      }
    })

    expect(result.snapshot.network).toEqual({})
  })

  it('feeds the existing drift engine without an intermediate shape conversion', () => {
    const baseline = buildRuntimeIdentitySnapshot({
      runtime: runtimeSnapshot(),
      network
    }).snapshot
    const changed = runtimeSnapshot()
    changed.webgl = {
      ...changed.webgl!,
      unmaskedRenderer: 'Google SwiftShader'
    }
    const current = buildRuntimeIdentitySnapshot({
      runtime: changed,
      network
    }).snapshot

    const report = compareIdentityBaseline('profile-1', 'baseline-1', baseline, current)

    expect(report.driftDetected).toBe(true)
    expect(report.severity).toBe('critical')
    expect(report.changes.some((change) => change.component === 'gpu')).toBe(true)
  })
})
