import type { FingerprintConfig, ProxyProtocol, ProxyTestResult } from './types'

export const GEOIP_CONFLICT_CONFIRMATION_PREFIX = '[ZBROWSER_GEOIP_CONFLICT_CONFIRMATION_REQUIRED]'
const LEGACY_GEOIP_CONFLICT_CONFIRMATION_PREFIX = '[PRISM_GEOIP_CONFLICT_CONFIRMATION_REQUIRED]'

export interface NetworkIdentityOptions {
  allowGeoConflict?: boolean
}

export interface NetworkIdentity {
  language: string
  acceptLanguages: string
  timezone: string
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  source: 'manual' | 'proxy'
}

export type NetworkIdentityReadiness =
  | 'manual'
  | 'direct'
  | 'unchecked'
  | 'failed'
  | 'incomplete'
  | 'conflict'
  | 'ready'

export interface NetworkIdentityPlan {
  readiness: NetworkIdentityReadiness
  ready: boolean
  canApply: boolean
  identity: NetworkIdentity
  proxyIp?: string
  countryCode?: string
  warnings: string[]
}

const COUNTRY_LOCALES: Record<string, { language: string; acceptLanguages: string }> = {
  AU: { language: 'en-AU', acceptLanguages: 'en-AU,en' },
  BR: { language: 'pt-BR', acceptLanguages: 'pt-BR,pt,en-US,en' },
  CA: { language: 'en-CA', acceptLanguages: 'en-CA,en-US,en' },
  CN: { language: 'zh-CN', acceptLanguages: 'zh-CN,zh,en-US,en' },
  DE: { language: 'de-DE', acceptLanguages: 'de-DE,de,en-US,en' },
  ES: { language: 'es-ES', acceptLanguages: 'es-ES,es,en-US,en' },
  FR: { language: 'fr-FR', acceptLanguages: 'fr-FR,fr,en-US,en' },
  GB: { language: 'en-GB', acceptLanguages: 'en-GB,en-US,en' },
  HK: { language: 'zh-HK', acceptLanguages: 'zh-HK,zh-TW,zh,en-US,en' },
  ID: { language: 'id-ID', acceptLanguages: 'id-ID,id,en-US,en' },
  IN: { language: 'en-IN', acceptLanguages: 'en-IN,en' },
  IT: { language: 'it-IT', acceptLanguages: 'it-IT,it,en-US,en' },
  JP: { language: 'ja-JP', acceptLanguages: 'ja-JP,ja,en-US,en' },
  KR: { language: 'ko-KR', acceptLanguages: 'ko-KR,ko,en-US,en' },
  MX: { language: 'es-MX', acceptLanguages: 'es-MX,es,en-US,en' },
  MY: { language: 'ms-MY', acceptLanguages: 'ms-MY,ms,en-US,en' },
  NL: { language: 'nl-NL', acceptLanguages: 'nl-NL,nl,en-US,en' },
  PH: { language: 'en-PH', acceptLanguages: 'en-PH,en-US,en' },
  RU: { language: 'ru-RU', acceptLanguages: 'ru-RU,ru,en-US,en' },
  SG: { language: 'en-SG', acceptLanguages: 'en-SG,en-US,en' },
  TH: { language: 'th-TH', acceptLanguages: 'th-TH,th,en-US,en' },
  TW: { language: 'zh-TW', acceptLanguages: 'zh-TW,zh,en-US,en' },
  US: { language: 'en-US', acceptLanguages: 'en-US,en' },
  VN: { language: 'vi-VN', acceptLanguages: 'vi-VN,vi,en-US,en' }
}

export function localeForCountry(countryCode: string | undefined): { language: string; acceptLanguages: string } | undefined {
  return countryCode ? COUNTRY_LOCALES[countryCode.toUpperCase()] : undefined
}

type CompleteProxyIdentity = ProxyTestResult & {
  ok: true
  ip: string
  countryCode: string
  timezone: string
  latitude: number
  longitude: number
}

export function hasCompleteProxyIdentity(
  check: ProxyTestResult | undefined,
  options: NetworkIdentityOptions = {}
): check is CompleteProxyIdentity {
  return Boolean(check?.ok
    && (check.geoConfidence !== 'conflict' || options.allowGeoConflict)
    && check.ip
    && check.countryCode
    && check.timezone
    && check.latitude !== undefined
    && check.longitude !== undefined)
}

export function effectiveNetworkIdentity(
  fingerprint: FingerprintConfig,
  check?: ProxyTestResult,
  options: NetworkIdentityOptions = {}
): NetworkIdentity {
  const fallback: NetworkIdentity = {
    language: fingerprint.language,
    acceptLanguages: fingerprint.acceptLanguages,
    timezone: fingerprint.timezone,
    source: 'manual'
  }
  if (fingerprint.networkIdentityMode !== 'proxy' || !hasCompleteProxyIdentity(check, options)) return fallback
  const locale = localeForCountry(check.countryCode)
  return {
    language: locale?.language ?? fallback.language,
    acceptLanguages: locale?.acceptLanguages ?? fallback.acceptLanguages,
    timezone: check.timezone ?? fallback.timezone,
    latitude: check.latitude,
    longitude: check.longitude,
    accuracyMeters: check.accuracyMeters,
    source: 'proxy'
  }
}

export function networkIdentityPlan(
  fingerprint: FingerprintConfig,
  proxyProtocol: ProxyProtocol,
  check?: ProxyTestResult,
  options: NetworkIdentityOptions = {}
): NetworkIdentityPlan {
  const manualIdentity: NetworkIdentity = {
    language: fingerprint.language,
    acceptLanguages: fingerprint.acceptLanguages,
    timezone: fingerprint.timezone,
    source: 'manual'
  }

  if (fingerprint.networkIdentityMode === 'manual') {
    return {
      readiness: 'manual',
      ready: true,
      canApply: false,
      identity: manualIdentity,
      warnings: []
    }
  }

  if (proxyProtocol === 'direct') {
    return {
      readiness: 'direct',
      ready: false,
      canApply: false,
      identity: manualIdentity,
      warnings: ['网络身份设置为跟随代理，但当前环境仍是直连']
    }
  }

  if (!check) {
    return {
      readiness: 'unchecked',
      ready: false,
      canApply: false,
      identity: manualIdentity,
      warnings: ['代理尚未检测，不能生成可信的自动网络身份']
    }
  }

  if (!check.ok) {
    return {
      readiness: 'failed',
      ready: false,
      canApply: false,
      identity: manualIdentity,
      warnings: [check.error ? `代理检测失败：${check.error}` : '代理检测失败，不能生成自动网络身份']
    }
  }

  if (check.geoConfidence === 'conflict' && !options.allowGeoConflict) {
    return {
      readiness: 'conflict',
      ready: false,
      canApply: false,
      identity: manualIdentity,
      proxyIp: check.ip,
      countryCode: check.countryCode,
      warnings: [check.geoConflict ?? 'GeoIP 数据源对代理地区或时区判断不一致']
    }
  }

  if (!hasCompleteProxyIdentity(check, options)) {
    return {
      readiness: 'incomplete',
      ready: false,
      canApply: false,
      identity: manualIdentity,
      proxyIp: check.ip,
      countryCode: check.countryCode,
      warnings: ['代理检测缺少出口 IP、国家、时区或城市级坐标，不能生成完整网络身份']
    }
  }

  return {
    readiness: 'ready',
    ready: true,
    canApply: true,
    identity: effectiveNetworkIdentity(fingerprint, check, options),
    proxyIp: check.ip,
    countryCode: check.countryCode,
    warnings: []
  }
}

export function applyRecommendedProxyNetworkIdentity(
  fingerprint: FingerprintConfig,
  check: ProxyTestResult,
  options: NetworkIdentityOptions = {}
): FingerprintConfig | undefined {
  if (!hasCompleteProxyIdentity(check, options)) return undefined
  const locale = localeForCountry(check.countryCode)
  return {
    ...fingerprint,
    networkIdentityMode: 'proxy',
    proxyExitPolicy: 'block',
    webrtcPolicy: 'proxy_only',
    timezone: check.timezone,
    language: locale?.language ?? fingerprint.language,
    acceptLanguages: locale?.acceptLanguages ?? fingerprint.acceptLanguages
  }
}

export function geoConflictConfirmationMessage(errorText: string): string | undefined {
  const currentMarker = errorText.indexOf(GEOIP_CONFLICT_CONFIRMATION_PREFIX)
  if (currentMarker >= 0) {
    return errorText.slice(currentMarker + GEOIP_CONFLICT_CONFIRMATION_PREFIX.length).replace(/^\s*[:：]?\s*/, '')
  }
  const legacyMarker = errorText.indexOf(LEGACY_GEOIP_CONFLICT_CONFIRMATION_PREFIX)
  if (legacyMarker < 0) return undefined
  return errorText.slice(legacyMarker + LEGACY_GEOIP_CONFLICT_CONFIRMATION_PREFIX.length).replace(/^\s*[:：]?\s*/, '')
}

export function proxyLaunchError(check: ProxyTestResult, exitPolicy: FingerprintConfig['proxyExitPolicy']): string | undefined {
  if (!check.ok) {
    if (check.failureKind === 'authentication') return '代理认证失败，请检查用户名和密码'
    if (check.failureKind === 'timeout') return '代理连接超时，请检查线路或更换代理'
    return `代理启动前检测失败：${check.error ?? '无法连接代理出口'}`
  }
  if (check.exitChanged && exitPolicy === 'block') {
    return `代理出口已从 ${check.previousIp ?? '原地址'} 变为 ${check.ip ?? '新地址'}；请确认后再次检测再启动`
  }
  return undefined
}
