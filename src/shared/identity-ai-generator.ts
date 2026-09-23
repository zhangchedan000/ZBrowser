import type {
  BrowserPlatform,
  FingerprintConfig,
  NetworkIdentityMode,
  ProxyProtocol,
  ProxyTestResult
} from './types'
import {
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
