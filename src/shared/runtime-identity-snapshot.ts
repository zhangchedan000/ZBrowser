export type IdentitySnapshotSource = 'runtime' | 'unknown'

export interface RuntimeBrowserSnapshot {
  userAgent?: string
  version?: string
  engine?: string
}

export interface RuntimeHardwareSnapshot {
  platform?: string
  architecture?: string
  memoryGb?: number
  cpuCores?: number
  screenWidth?: number
  screenHeight?: number
  devicePixelRatio?: number
}

export interface RuntimeGpuSnapshot {
  webglVendor?: string
  webglRenderer?: string
  webgpuAdapter?: string
  softwareRenderer?: boolean
}

export interface RuntimeRenderingSnapshot {
  canvasFingerprint?: string
  audioFingerprint?: string
  fonts?: string[]
}

export interface RuntimeNetworkSnapshot {
  ip?: string
  country?: string
  timezone?: string
  webrtcPolicy?: string
}

export interface RuntimeLocaleSnapshot {
  language?: string
  languages?: string[]
  timezone?: string
  region?: string
}

export interface IdentitySnapshot {
  source: IdentitySnapshotSource
  capturedAt: string
  browser: RuntimeBrowserSnapshot
  hardware: RuntimeHardwareSnapshot
  gpu: RuntimeGpuSnapshot
  rendering: RuntimeRenderingSnapshot
  network: RuntimeNetworkSnapshot
  locale: RuntimeLocaleSnapshot
}

export interface RuntimeIdentitySnapshotInput {
  browser?: RuntimeBrowserSnapshot
  hardware?: RuntimeHardwareSnapshot
  gpu?: RuntimeGpuSnapshot
  rendering?: RuntimeRenderingSnapshot
  network?: RuntimeNetworkSnapshot
  locale?: RuntimeLocaleSnapshot
  source?: IdentitySnapshotSource
}

/**
 * Adapter between existing runtime diagnostic collectors and IdentityBaseline.
 * This intentionally does not collect data itself. Existing IPC/CDP/runtime
 * checks remain the source of truth and pass their results here.
 */
export function createRuntimeIdentitySnapshot(
  input: RuntimeIdentitySnapshotInput
): IdentitySnapshot {
  return {
    source: input.source ?? 'runtime',
    capturedAt: new Date().toISOString(),
    browser: input.browser ?? {},
    hardware: input.hardware ?? {},
    gpu: input.gpu ?? {},
    rendering: input.rendering ?? {},
    network: input.network ?? {},
    locale: input.locale ?? {}
  }
}

export function mergeRuntimeIdentitySnapshot(
  current: IdentitySnapshot,
  patch: RuntimeIdentitySnapshotInput
): IdentitySnapshot {
  return {
    ...current,
    capturedAt: new Date().toISOString(),
    browser: { ...current.browser, ...patch.browser },
    hardware: { ...current.hardware, ...patch.hardware },
    gpu: { ...current.gpu, ...patch.gpu },
    rendering: { ...current.rendering, ...patch.rendering },
    network: { ...current.network, ...patch.network },
    locale: { ...current.locale, ...patch.locale }
  }
}
