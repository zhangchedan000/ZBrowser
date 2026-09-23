import type { IdentityBaselineSnapshot } from './identity-baseline-model'
import type { EngineStatus, ProxyCheckSummary, RuntimeFingerprintSnapshot } from './types'

export type IdentitySnapshot = IdentityBaselineSnapshot

export interface RuntimeIdentitySnapshotInput {
  runtime: RuntimeFingerprintSnapshot
  engine?: Pick<EngineStatus, 'fingerprintKernel' | 'version'>
  network?: ProxyCheckSummary
  capturedAt?: string
}

export interface RuntimeIdentitySnapshotResult {
  capturedAt: string
  snapshot: IdentitySnapshot
}

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort((a, b) => a.localeCompare(b))
}

function observedNetwork(network: ProxyCheckSummary | undefined): IdentitySnapshot['network'] {
  if (!network?.ok) return {}

  return {
    ip: network.ip,
    ipVersion: network.ipVersion,
    country: network.country,
    countryCode: network.countryCode,
    region: network.region,
    city: network.city,
    timezone: network.timezone,
    latitude: network.latitude,
    longitude: network.longitude,
    asn: network.asn,
    organization: network.organization,
    isp: network.isp,
    networkRisk: network.networkRisk,
    geoConfidence: network.geoConfidence
  }
}

/**
 * Converts values already observed by the existing runtime diagnostics into the
 * stable six-part identity shape consumed by IdentityBaseline/Drift Detection.
 *
 * This adapter deliberately performs no probing and does not read profile
 * configuration as a substitute for runtime evidence.
 */
export function buildRuntimeIdentitySnapshot(
  input: RuntimeIdentitySnapshotInput
): RuntimeIdentitySnapshotResult {
  const runtime = input.runtime

  return {
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    snapshot: {
      browser: {
        userAgent: runtime.userAgent,
        platform: runtime.platform,
        kernelVersion: input.engine?.fingerprintKernel ? input.engine.version : undefined,
        uaCh: {
          exposed: runtime.uaCh.exposed,
          platform: runtime.uaCh.platform,
          mobile: runtime.uaCh.mobile,
          brands: runtime.uaCh.brands.map((item) => ({ ...item })),
          architecture: runtime.uaCh.architecture,
          bitness: runtime.uaCh.bitness,
          platformVersion: runtime.uaCh.platformVersion,
          fullVersionList: runtime.uaCh.fullVersionList.map((item) => ({ ...item }))
        }
      },
      hardware: {
        hardwareConcurrency: runtime.hardwareConcurrency,
        deviceMemory: runtime.deviceMemory,
        devicePixelRatio: runtime.devicePixelRatio,
        screen: { ...runtime.screen }
      },
      gpu: {
        webgl: runtime.webgl ? { ...runtime.webgl } : undefined,
        webgpu: runtime.webgpu ? { ...runtime.webgpu } : undefined,
        systemGpu: runtime.systemGpu
          ? {
              devices: runtime.systemGpu.devices.map((device) => ({ ...device })),
              glVendor: runtime.systemGpu.glVendor,
              glRenderer: runtime.systemGpu.glRenderer
            }
          : undefined
      },
      rendering: {
        fonts: runtime.fonts
          ? {
              method: runtime.fonts.method,
              detected: sorted(runtime.fonts.detected)
            }
          : undefined
      },
      network: observedNetwork(input.network),
      locale: {
        language: runtime.language,
        languages: [...runtime.languages],
        timezone: runtime.timezone
      }
    }
  }
}
