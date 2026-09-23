import type {
  BrowserPlatform,
  FingerprintConfig,
  NetworkIdentityMode,
  ProxyProtocol,
  ProxyTestResult,
  IdentityConfigProvenance,
  IdentityConfigSection
} from './types'
import {
  applyFingerprintHardwarePersona,
  fingerprintHardwareRegionForCountry,
  recommendFingerprintHardwarePersona
} from './fingerprint-persona-engine'
import {
  localeForCountry,
  networkIdentityPlan,
  type NetworkIdentityPlan
} from './network-identity'
import type {
  IdentityConfigProfile,
  IdentityConfigValue
} from './identity-config-engine'
import { HARDWARE_IDENTITY_FIELDS, identityConfigSource, markIdentityConfigFields, normalizeIdentityConfigProvenance } from './identity-config-provenance'

export interface AIIdentityGenerationRequest {
  baseFingerprint: FingerprintConfig
  platform?: BrowserPlatform
  countryCode?: string
  proxyProtocol?: ProxyProtocol
  proxyCheck?: ProxyTestResult
  networkMode?: NetworkIdentityMode
  asOf?: string
}

export interface AIIdentityGenerationResult {
  config: IdentityConfigProfile
  warnings: string[]
  personaId?: string
  networkReadiness: NetworkIdentityPlan['readiness']
}

function aiValue<T>(value: T): IdentityConfigValue<T> {
  return {
    value,
    source: 'ai',
    updatedAt: new Date().toISOString()
  }
}

function generatedValue<T>(value: IdentityConfigValue | undefined): T | undefined {
  return value?.value as T | undefined
}

export function generateAIIdentityConfig(
  request: AIIdentityGenerationRequest
): AIIdentityGenerationResult {
  const base = request.baseFingerprint
  const platform = request.platform ?? base.platform
  const countryCode = (request.proxyCheck?.countryCode ?? request.countryCode)?.toUpperCase()
  const networkMode = request.networkMode ?? base.networkIdentityMode

  const persona = recommendFingerprintHardwarePersona({
    platform,
    seed: base.seed,
    region: fingerprintHardwareRegionForCountry(countryCode),
    asOf: request.asOf
  })

  const networkFingerprint: FingerprintConfig = {
    ...base,
    platform,
    networkIdentityMode: networkMode
  }
  const networkPlan = networkIdentityPlan(
    networkFingerprint,
    request.proxyProtocol ?? 'direct',
    request.proxyCheck
  )

  const fallbackLocale = localeForCountry(countryCode)
  const locale = networkPlan.ready
    ? networkPlan.identity
    : {
        language: fallbackLocale?.language ?? base.language,
        acceptLanguages: fallbackLocale?.acceptLanguages ?? base.acceptLanguages,
        timezone: base.timezone,
        source: 'manual' as const
      }

  const fingerprint: IdentityConfigProfile['fingerprint'] = {
    platform: aiValue(platform)
  }

  if (persona) {
    fingerprint.hardwarePersonaId = aiValue(persona.id)
    fingerprint.platformVersion = aiValue(persona.platformVersion)
    fingerprint.hardwareConcurrency = aiValue(persona.hardwareConcurrency)
    fingerprint.screenWidth = aiValue(persona.screenWidth)
    fingerprint.screenHeight = aiValue(persona.screenHeight)
    fingerprint.architecture = aiValue(persona.architecture)
    fingerprint.bitness = aiValue(persona.bitness)
    fingerprint.deviceMemoryGb = aiValue(persona.browserDeviceMemoryGb)
    fingerprint.devicePixelRatio = aiValue(persona.devicePixelRatio)
    fingerprint.colorDepth = aiValue(persona.colorDepth)
    fingerprint.pixelDepth = aiValue(persona.pixelDepth)
  }

  const network: IdentityConfigProfile['network'] = {
    networkIdentityMode: aiValue(networkMode),
    proxyExitPolicy: aiValue(networkMode === 'proxy' ? 'block' : base.proxyExitPolicy),
    webrtcPolicy: aiValue(networkMode === 'proxy' ? 'proxy_only' : base.webrtcPolicy)
  }

  if (request.proxyCheck?.ip) network.proxyIp = aiValue(request.proxyCheck.ip)
  if (countryCode) network.countryCode = aiValue(countryCode)
  if (request.proxyCheck?.asn !== undefined) network.asn = aiValue(request.proxyCheck.asn)
  if (request.proxyCheck?.organization) network.organization = aiValue(request.proxyCheck.organization)
  if (request.proxyCheck?.isp) network.isp = aiValue(request.proxyCheck.isp)

  const localeConfig: IdentityConfigProfile['locale'] = {
    language: aiValue(locale.language),
    acceptLanguages: aiValue(locale.acceptLanguages),
    timezone: aiValue(locale.timezone)
  }

  if (networkPlan.identity.latitude !== undefined) {
    localeConfig.latitude = aiValue(networkPlan.identity.latitude)
  }
  if (networkPlan.identity.longitude !== undefined) {
    localeConfig.longitude = aiValue(networkPlan.identity.longitude)
  }
  if (networkPlan.identity.accuracyMeters !== undefined) {
    localeConfig.accuracyMeters = aiValue(networkPlan.identity.accuracyMeters)
  }

  const browser: IdentityConfigProfile['browser'] = {
    brand: aiValue(base.brand)
  }
  if (base.brandVersion) browser.brandVersion = aiValue(base.brandVersion)

  const warnings = [...networkPlan.warnings]
  if (!persona) {
    warnings.push(`未找到适用于 ${platform} / ${countryCode ?? 'global'} 的 Hardware Persona，保留现有硬件配置`)
  }

  return {
    config: {
      fingerprint,
      network,
      locale: localeConfig,
      browser
    },
    warnings,
    personaId: persona?.id,
    networkReadiness: networkPlan.readiness
  }
}

export function applyAIIdentityConfigToFingerprint(
  base: FingerprintConfig,
  generated: AIIdentityGenerationResult,
  provenance?: IdentityConfigProvenance
): FingerprintConfig {
  const currentProvenance = normalizeIdentityConfigProvenance(provenance)
  const canApply = (section: IdentityConfigSection, key: string): boolean =>
    identityConfigSource(currentProvenance, section, key) !== 'user'
  const hardwareLocked = HARDWARE_IDENTITY_FIELDS.some((key) =>
    identityConfigSource(currentProvenance, 'fingerprint', key) === 'user'
  )
  const networkModeLocked = identityConfigSource(currentProvenance, 'network', 'networkIdentityMode') === 'user'

  let next = generated.personaId && !hardwareLocked
    ? applyFingerprintHardwarePersona(base, generated.personaId) ?? { ...base }
    : { ...base }

  const fingerprint = generated.config.fingerprint
  const browser = generated.config.browser
  const network = generated.config.network
  const locale = generated.config.locale

  if (!hardwareLocked) {
    const architecture = generatedValue<FingerprintConfig['architecture']>(fingerprint.architecture)
    const bitness = generatedValue<FingerprintConfig['bitness']>(fingerprint.bitness)
    const deviceMemoryGb = generatedValue<FingerprintConfig['deviceMemoryGb']>(fingerprint.deviceMemoryGb)
    const devicePixelRatio = generatedValue<number>(fingerprint.devicePixelRatio)
    const colorDepth = generatedValue<FingerprintConfig['colorDepth']>(fingerprint.colorDepth)
    const pixelDepth = generatedValue<FingerprintConfig['pixelDepth']>(fingerprint.pixelDepth)

    next = {
      ...next,
      platform: canApply('fingerprint', 'platform') ? generatedValue<BrowserPlatform>(fingerprint.platform) ?? next.platform : next.platform,
      platformVersion: canApply('fingerprint', 'platformVersion') ? generatedValue<string>(fingerprint.platformVersion) ?? next.platformVersion : next.platformVersion,
      hardwareConcurrency: canApply('fingerprint', 'hardwareConcurrency') ? generatedValue<number>(fingerprint.hardwareConcurrency) ?? next.hardwareConcurrency : next.hardwareConcurrency,
      screenWidth: canApply('fingerprint', 'screenWidth') ? generatedValue<number>(fingerprint.screenWidth) ?? next.screenWidth : next.screenWidth,
      screenHeight: canApply('fingerprint', 'screenHeight') ? generatedValue<number>(fingerprint.screenHeight) ?? next.screenHeight : next.screenHeight,
      ...(architecture && canApply('fingerprint', 'architecture') ? { architecture } : {}),
      ...(bitness && canApply('fingerprint', 'bitness') ? { bitness } : {}),
      ...(deviceMemoryGb !== undefined && canApply('fingerprint', 'deviceMemoryGb') ? { deviceMemoryGb } : {}),
      ...(devicePixelRatio !== undefined && canApply('fingerprint', 'devicePixelRatio') ? { devicePixelRatio } : {}),
      ...(colorDepth !== undefined && canApply('fingerprint', 'colorDepth') ? { colorDepth } : {}),
      ...(pixelDepth !== undefined && canApply('fingerprint', 'pixelDepth') ? { pixelDepth } : {})
    }
  }

  next = {
    ...next,
    brand: canApply('browser', 'brand') ? generatedValue<FingerprintConfig['brand']>(browser.brand) ?? next.brand : next.brand,
    brandVersion: canApply('browser', 'brandVersion') ? generatedValue<string>(browser.brandVersion) ?? next.brandVersion : next.brandVersion
  }

  const networkMode = generatedValue<NetworkIdentityMode>(network.networkIdentityMode) ?? next.networkIdentityMode
  const networkCanApply = !networkModeLocked && (networkMode === 'manual' || generated.networkReadiness === 'ready')
  if (!networkCanApply) return next

  return {
    ...next,
    networkIdentityMode: canApply('network', 'networkIdentityMode') ? networkMode : next.networkIdentityMode,
    proxyExitPolicy: canApply('network', 'proxyExitPolicy')
      ? generatedValue<FingerprintConfig['proxyExitPolicy']>(network.proxyExitPolicy) ?? next.proxyExitPolicy
      : next.proxyExitPolicy,
    webrtcPolicy: canApply('network', 'webrtcPolicy')
      ? generatedValue<FingerprintConfig['webrtcPolicy']>(network.webrtcPolicy) ?? next.webrtcPolicy
      : next.webrtcPolicy,
    language: canApply('locale', 'language') ? generatedValue<string>(locale.language) ?? next.language : next.language,
    acceptLanguages: canApply('locale', 'acceptLanguages') ? generatedValue<string>(locale.acceptLanguages) ?? next.acceptLanguages : next.acceptLanguages,
    timezone: canApply('locale', 'timezone') ? generatedValue<string>(locale.timezone) ?? next.timezone : next.timezone
  }
}

export function applyAIIdentityConfigProvenance(
  provenance: IdentityConfigProvenance | undefined,
  generated: AIIdentityGenerationResult
): IdentityConfigProvenance {
  const current = normalizeIdentityConfigProvenance(provenance)
  const hardwareLocked = HARDWARE_IDENTITY_FIELDS.some((key) =>
    identityConfigSource(current, 'fingerprint', key) === 'user'
  )
  const networkModeLocked = identityConfigSource(current, 'network', 'networkIdentityMode') === 'user'
  const networkMode = generatedValue<NetworkIdentityMode>(generated.config.network.networkIdentityMode)
  const networkCanApply = !networkModeLocked
    && (networkMode === 'manual' || generated.networkReadiness === 'ready')

  let next = current
  if (generated.personaId && !hardwareLocked) {
    next = markIdentityConfigFields(next, 'fingerprint', HARDWARE_IDENTITY_FIELDS, 'ai', true)
  }

  for (const [section, values] of Object.entries(generated.config) as Array<[IdentityConfigSection, Record<string, IdentityConfigValue>]>) {
    if ((section === 'network' || section === 'locale') && !networkCanApply) continue
    const keys = Object.keys(values).filter((key) => {
      if (identityConfigSource(current, section, key) === 'user') return false
      if (section === 'fingerprint' && hardwareLocked && HARDWARE_IDENTITY_FIELDS.includes(key as (typeof HARDWARE_IDENTITY_FIELDS)[number])) return false
      return true
    })
    next = markIdentityConfigFields(next, section, keys, 'ai', true)
  }

  return next
}
