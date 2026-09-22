import type { BrowserPlatform, FingerprintConfig } from './types'
import {
  compatibleHardwarePersonas,
  hardwarePersona,
  type FingerprintHardwarePersona,
  type FingerprintHardwareRegion
} from './fingerprint-hardware-database'
import {
  effectiveGpuIdentity,
  effectiveHardwareSurfaceIdentity,
  hardwareProfile
} from './hardware-profiles'

export type FingerprintPersonaSource =
  | 'catalog'
  | 'seeded-profile'
  | 'fixed-profile'
  | 'host-native'
  | 'legacy-custom'

export type FingerprintPersonaConsistency = 'coherent' | 'legacy' | 'unresolved' | 'conflict'

export interface FingerprintPersonaResolution {
  source: FingerprintPersonaSource
  consistency: FingerprintPersonaConsistency
  stableKey: string
  personaId?: string
  label: string
  platform: BrowserPlatform
  platformVersion: string
  architecture?: 'x86' | 'arm'
  bitness?: '64'
  hardwareConcurrency: number
  physicalMemoryGb?: number
  deviceMemoryGb?: FingerprintConfig['deviceMemoryGb']
  screenWidth: number
  screenHeight: number
  devicePixelRatio?: number
  colorDepth?: 24
  pixelDepth?: 24
  gpuModel?: string
  sourceIds: string[]
  warnings: string[]
}

export interface FingerprintPersonaRecommendationOptions {
  platform: BrowserPlatform
  seed: number
  region?: FingerprintHardwareRegion
  asOf?: string
}

function compareValue(
  warnings: string[],
  label: string,
  actual: string | number | undefined,
  expected: string | number
): void {
  if (actual === undefined || actual === '') return
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Math.abs(actual - expected) <= 0.01) return
  } else if (actual === expected) {
    return
  }
  warnings.push(`${label} ${actual} 与 Persona ${expected} 不一致`)
}

function catalogWarnings(config: FingerprintConfig, persona: FingerprintHardwarePersona): string[] {
  const warnings: string[] = []
  compareValue(warnings, '系统平台', config.platform, persona.platform)
  compareValue(warnings, '系统版本', config.platformVersion, persona.platformVersion)
  compareValue(warnings, 'CPU 核心数', config.hardwareConcurrency, persona.hardwareConcurrency)
  compareValue(warnings, '屏幕宽度', config.screenWidth, persona.screenWidth)
  compareValue(warnings, '屏幕高度', config.screenHeight, persona.screenHeight)
  compareValue(warnings, 'CPU 架构', config.architecture, persona.architecture)
  compareValue(warnings, '浏览器位数', config.bitness, persona.bitness)
  compareValue(warnings, 'deviceMemory', config.deviceMemoryGb, persona.browserDeviceMemoryGb)
  compareValue(warnings, 'DPR', config.devicePixelRatio, persona.devicePixelRatio)
  compareValue(warnings, 'colorDepth', config.colorDepth, persona.colorDepth)
  compareValue(warnings, 'pixelDepth', config.pixelDepth, persona.pixelDepth)

  const gpu = effectiveGpuIdentity(config)
  if (gpu) compareValue(warnings, 'GPU', gpu.model, persona.gpuModel)
  return warnings
}

function derivedResolution(
  config: FingerprintConfig,
  source: Exclude<FingerprintPersonaSource, 'catalog' | 'legacy-custom'>,
  consistency: FingerprintPersonaConsistency,
  label: string,
  warnings: string[]
): FingerprintPersonaResolution {
  const profile = hardwareProfile(config.hardwareProfileId)
  const surface = effectiveHardwareSurfaceIdentity(config)
  const gpu = effectiveGpuIdentity(config)
  return {
    source,
    consistency,
    stableKey: source === 'seeded-profile'
      ? `seeded:${config.hardwareProfileId}:${gpu?.bucket ?? 'legacy'}`
      : `${source}:${config.hardwareProfileId}`,
    label,
    platform: config.platform,
    platformVersion: config.platformVersion,
    architecture: config.architecture ?? surface.architecture,
    bitness: config.bitness ?? surface.bitness,
    hardwareConcurrency: config.hardwareConcurrency,
    physicalMemoryGb: profile?.physicalMemoryGb,
    deviceMemoryGb: config.deviceMemoryGb ?? surface.deviceMemoryGb,
    screenWidth: config.screenWidth,
    screenHeight: config.screenHeight,
    devicePixelRatio: config.devicePixelRatio ?? surface.devicePixelRatio,
    colorDepth: config.colorDepth ?? surface.colorDepth,
    pixelDepth: config.pixelDepth ?? surface.pixelDepth,
    gpuModel: gpu?.model ?? profile?.gpuModel,
    sourceIds: [],
    warnings
  }
}

/**
 * Resolve the effective hardware persona without mutating the stored Profile.
 * Existing seeded and legacy Profiles keep their pinned identity; this engine
 * only describes what is already saved so newer recommendation logic cannot
 * silently remap an environment that has already been used.
 */
export function resolveFingerprintPersona(config: FingerprintConfig): FingerprintPersonaResolution {
  const surface = effectiveHardwareSurfaceIdentity(config)
  const requestedPersona = config.hardwarePersonaId ? hardwarePersona(config.hardwarePersonaId) : undefined
  const inferredPersona = surface.personaId ? hardwarePersona(surface.personaId) : undefined
  const persona = requestedPersona ?? inferredPersona

  if (persona) {
    const warnings = catalogWarnings(config, persona)
    if (config.hardwarePersonaId && !requestedPersona) {
      warnings.unshift(`已保存 Persona ${config.hardwarePersonaId} 不在当前目录中，按硬件模板解析为 ${persona.id}`)
    }
    if (config.hardwarePersonaId && surface.personaId && config.hardwarePersonaId !== surface.personaId) {
      warnings.unshift(`已保存 Persona ${config.hardwarePersonaId} 与硬件模板 Persona ${surface.personaId} 不一致`)
    }
    return {
      source: 'catalog',
      consistency: warnings.length ? 'conflict' : 'coherent',
      stableKey: `persona:${persona.id}`,
      personaId: persona.id,
      label: persona.label,
      platform: persona.platform,
      platformVersion: persona.platformVersion,
      architecture: persona.architecture,
      bitness: persona.bitness,
      hardwareConcurrency: persona.hardwareConcurrency,
      physicalMemoryGb: persona.physicalMemoryGb,
      deviceMemoryGb: persona.browserDeviceMemoryGb,
      screenWidth: persona.screenWidth,
      screenHeight: persona.screenHeight,
      devicePixelRatio: persona.devicePixelRatio,
      colorDepth: persona.colorDepth,
      pixelDepth: persona.pixelDepth,
      gpuModel: persona.gpuModel,
      sourceIds: [...persona.sourceIds],
      warnings
    }
  }

  const profile = hardwareProfile(config.hardwareProfileId)
  if (profile?.hostMatched) {
    return derivedResolution(config, 'host-native', 'coherent', profile.label, [])
  }

  if (profile?.renderIdentityMode === 'seeded-curated') {
    const gpu = effectiveGpuIdentity(config)
    if (!gpu) {
      return derivedResolution(
        config,
        'seeded-profile',
        'unresolved',
        profile.label,
        ['这是未固定 GPU bucket 的旧 seeded 环境；为避免指纹突变，Persona Engine 不会自动重新分配 GPU']
      )
    }
    return derivedResolution(config, 'seeded-profile', 'coherent', `${profile.label} · ${gpu.model}`, [])
  }

  if (profile) {
    return derivedResolution(config, 'fixed-profile', 'coherent', profile.label, [])
  }

  return {
    source: 'legacy-custom',
    consistency: 'legacy',
    stableKey: `legacy:${config.platform}:${config.hardwareConcurrency}:${config.screenWidth}x${config.screenHeight}`,
    label: '旧版自定义硬件组合',
    platform: config.platform,
    platformVersion: config.platformVersion,
    architecture: config.architecture,
    bitness: config.bitness,
    hardwareConcurrency: config.hardwareConcurrency,
    deviceMemoryGb: config.deviceMemoryGb,
    screenWidth: config.screenWidth,
    screenHeight: config.screenHeight,
    devicePixelRatio: config.devicePixelRatio,
    colorDepth: config.colorDepth,
    pixelDepth: config.pixelDepth,
    sourceIds: [],
    warnings: ['旧版自定义环境未绑定 Hardware Persona 合同；保持原有指纹，不自动重写']
  }
}

/**
 * Deterministic weighted recommendation for new Profiles only.
 * The returned Persona is never applied to an existing Profile implicitly.
 */
export function recommendFingerprintHardwarePersona(
  options: FingerprintPersonaRecommendationOptions
): FingerprintHardwarePersona | undefined {
  const candidates = compatibleHardwarePersonas({
    platform: options.platform,
    region: options.region,
    asOf: options.asOf
  }).filter((persona) => persona.popularityWeight > 0)
  if (!candidates.length) return undefined

  const totalWeight = candidates.reduce((sum, persona) => sum + persona.popularityWeight, 0)
  let slot = (options.seed >>> 0) % totalWeight
  for (const persona of candidates) {
    if (slot < persona.popularityWeight) return persona
    slot -= persona.popularityWeight
  }
  return candidates[candidates.length - 1]
}
