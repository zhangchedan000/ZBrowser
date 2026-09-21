import type { BrowserPlatform } from './types'

export type FingerprintHardwareRegion = 'global' | 'us' | 'eu' | 'apac'
export type FingerprintHardwareSourceKind =
  | 'hardware-survey'
  | 'browser-spec'
  | 'vendor-spec'
  | 'device-id-database'
  | 'measured-probe'

export interface FingerprintHardwareSource {
  id: string
  kind: FingerprintHardwareSourceKind
  label: string
  url: string
  checkedAt: string
}

export interface FingerprintHardwarePersona {
  id: string
  label: string
  platform: BrowserPlatform
  platformVersion: string
  architecture: 'x86' | 'arm'
  bitness: '64'
  cpuClass: 'entry' | 'mainstream' | 'performance' | 'enthusiast'
  hardwareConcurrency: number
  physicalMemoryGb: 8 | 16 | 24 | 32 | 64
  browserDeviceMemoryGb: 8
  gpuVendor: 'NVIDIA' | 'AMD' | 'Intel' | 'Apple'
  gpuModel: string
  screenWidth: number
  screenHeight: number
  devicePixelRatio: 1 | 1.25 | 1.5 | 2
  colorDepth: 24
  pixelDepth: 24
  regions: FingerprintHardwareRegion[]
  popularityWeight: number
  validFrom: string
  validTo?: string
  sourceIds: string[]
}

/**
 * Source catalogue for the hardware-persona layer.
 * The values in this file are deliberately provenance-aware so the runtime
 * can distinguish measured browser behaviour from broad hardware popularity.
 */
export const FINGERPRINT_HARDWARE_SOURCES: readonly FingerprintHardwareSource[] = [
  {
    id: 'steam-hardware-survey',
    kind: 'hardware-survey',
    label: 'Steam Hardware & Software Survey',
    url: 'https://store.steampowered.com/hwsurvey/',
    checkedAt: '2026-09-21'
  },
  {
    id: 'device-memory-api',
    kind: 'browser-spec',
    label: 'Device Memory API behaviour',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory',
    checkedAt: '2026-09-21'
  },
  {
    id: 'ua-client-hints',
    kind: 'browser-spec',
    label: 'Chromium User-Agent Client Hints',
    url: 'https://developer.chrome.com/docs/privacy-security/user-agent-client-hints',
    checkedAt: '2026-09-21'
  },
  {
    id: 'zbrowser-kernel-probe',
    kind: 'measured-probe',
    label: 'ZBrowser fingerprint-kernel runtime probes',
    url: 'internal://fingerprint-runtime-probe',
    checkedAt: '2026-09-21'
  }
]

/**
 * Starter personas are compatibility-safe anchors, not a claim that these are
 * exact market-share percentages. popularityWeight is a relative sampling
 * weight inside ZBrowser and should be recalibrated as source data is updated.
 */
export const FINGERPRINT_HARDWARE_PERSONAS: readonly FingerprintHardwarePersona[] = [
  {
    id: 'win-mainstream-3060-1080p',
    label: 'Windows mainstream · RTX 3060 · 1080p',
    platform: 'windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    bitness: '64',
    cpuClass: 'mainstream',
    hardwareConcurrency: 8,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    gpuVendor: 'NVIDIA',
    gpuModel: 'NVIDIA GeForce RTX 3060',
    screenWidth: 1920,
    screenHeight: 1080,
    devicePixelRatio: 1,
    colorDepth: 24,
    pixelDepth: 24,
    regions: ['global', 'us', 'eu'],
    popularityWeight: 100,
    validFrom: '2024-01-01',
    sourceIds: ['steam-hardware-survey', 'device-memory-api', 'ua-client-hints', 'zbrowser-kernel-probe']
  },
  {
    id: 'win-mainstream-4060-1080p',
    label: 'Windows mainstream · RTX 4060 · 1080p',
    platform: 'windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    bitness: '64',
    cpuClass: 'mainstream',
    hardwareConcurrency: 12,
    physicalMemoryGb: 16,
    browserDeviceMemoryGb: 8,
    gpuVendor: 'NVIDIA',
    gpuModel: 'NVIDIA GeForce RTX 4060',
    screenWidth: 1920,
    screenHeight: 1080,
    devicePixelRatio: 1,
    colorDepth: 24,
    pixelDepth: 24,
    regions: ['global', 'us', 'eu'],
    popularityWeight: 90,
    validFrom: '2024-01-01',
    sourceIds: ['steam-hardware-survey', 'device-memory-api', 'ua-client-hints', 'zbrowser-kernel-probe']
  },
  {
    id: 'win-performance-4070-1440p',
    label: 'Windows performance · RTX 4070 · 1440p',
    platform: 'windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    bitness: '64',
    cpuClass: 'performance',
    hardwareConcurrency: 16,
    physicalMemoryGb: 32,
    browserDeviceMemoryGb: 8,
    gpuVendor: 'NVIDIA',
    gpuModel: 'NVIDIA GeForce RTX 4070',
    screenWidth: 2560,
    screenHeight: 1440,
    devicePixelRatio: 1,
    colorDepth: 24,
    pixelDepth: 24,
    regions: ['global', 'us', 'eu'],
    popularityWeight: 55,
    validFrom: '2024-01-01',
    sourceIds: ['steam-hardware-survey', 'device-memory-api', 'ua-client-hints', 'zbrowser-kernel-probe']
  },
  {
    id: 'mac-mainstream-m1',
    label: 'macOS mainstream · Apple M1',
    platform: 'macos',
    platformVersion: '13.0.0',
    architecture: 'arm',
    bitness: '64',
    cpuClass: 'mainstream',
    hardwareConcurrency: 8,
    physicalMemoryGb: 8,
    browserDeviceMemoryGb: 8,
    gpuVendor: 'Apple',
    gpuModel: 'Apple M1',
    screenWidth: 1440,
    screenHeight: 900,
    devicePixelRatio: 2,
    colorDepth: 24,
    pixelDepth: 24,
    regions: ['global', 'us', 'eu', 'apac'],
    popularityWeight: 80,
    validFrom: '2023-01-01',
    sourceIds: ['device-memory-api', 'ua-client-hints', 'zbrowser-kernel-probe']
  }
]

export function hardwarePersona(id: string): FingerprintHardwarePersona | undefined {
  return FINGERPRINT_HARDWARE_PERSONAS.find((persona) => persona.id === id)
}

export function compatibleHardwarePersonas(options: {
  platform?: BrowserPlatform
  region?: FingerprintHardwareRegion
  asOf?: string
} = {}): FingerprintHardwarePersona[] {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10)
  return FINGERPRINT_HARDWARE_PERSONAS
    .filter((persona) => !options.platform || persona.platform === options.platform)
    .filter((persona) => !options.region || persona.regions.includes(options.region) || persona.regions.includes('global'))
    .filter((persona) => persona.validFrom <= asOf && (!persona.validTo || persona.validTo >= asOf))
    .sort((a, b) => b.popularityWeight - a.popularityWeight)
}
