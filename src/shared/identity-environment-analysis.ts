import type { ProxyProtocol, ProxyTestResult } from './types'

export type IdentityEnvironmentAnalysisStatus =
  | 'ready'
  | 'manual'
  | 'invalid_target'
  | 'proxy_unavailable'
  | 'geo_conflict'
  | 'country_mismatch'

export interface IdentityEnvironmentAnalysisRequest {
  targetCountryCode?: string
  proxyProtocol: ProxyProtocol
  proxyCheck?: ProxyTestResult
}

export interface IdentityEnvironmentAnalysis {
  status: IdentityEnvironmentAnalysisStatus
  canGenerate: boolean
  targetCountryCode?: string
  observedCountryCode?: string
  effectiveCountryCode?: string
  warnings: string[]
}

function normalizeCountryCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase()
  return normalized || undefined
}

export function analyzeIdentityEnvironment(
  request: IdentityEnvironmentAnalysisRequest
): IdentityEnvironmentAnalysis {
  const targetCountryCode = normalizeCountryCode(request.targetCountryCode)
  const observedCountryCode = normalizeCountryCode(request.proxyCheck?.countryCode)

  if (targetCountryCode && !/^[A-Z]{2}$/.test(targetCountryCode)) {
    return {
      status: 'invalid_target',
      canGenerate: false,
      targetCountryCode,
      observedCountryCode,
      warnings: ['目标国家必须使用 ISO 两位国家代码，例如 US、GB、DE']
    }
  }

  if (request.proxyProtocol === 'direct') {
    return {
      status: 'manual',
      canGenerate: true,
      targetCountryCode,
      effectiveCountryCode: targetCountryCode,
      warnings: targetCountryCode ? [] : ['未指定目标国家，将保留当前地区与网络配置']
    }
  }

  if (!request.proxyCheck?.ok) {
    return {
      status: 'proxy_unavailable',
      canGenerate: false,
      targetCountryCode,
      observedCountryCode,
      warnings: [request.proxyCheck?.error ? `代理检测失败：${request.proxyCheck.error}` : '代理尚未通过检测']
    }
  }

  if (request.proxyCheck.geoConfidence === 'conflict') {
    return {
      status: 'geo_conflict',
      canGenerate: false,
      targetCountryCode,
      observedCountryCode,
      warnings: [request.proxyCheck.geoConflict
        ? `代理 GeoIP 数据源冲突：${request.proxyCheck.geoConflict}`
        : '代理 GeoIP 数据源存在冲突，不能安全生成地区身份']
    }
  }

  if (!observedCountryCode) {
    return {
      status: 'proxy_unavailable',
      canGenerate: false,
      targetCountryCode,
      warnings: ['代理检测没有返回国家代码，不能确认目标国家']
    }
  }

  if (targetCountryCode && observedCountryCode !== targetCountryCode) {
    return {
      status: 'country_mismatch',
      canGenerate: false,
      targetCountryCode,
      observedCountryCode,
      warnings: [`目标国家 ${targetCountryCode} 与代理实际出口 ${observedCountryCode} 不一致`]
    }
  }

  return {
    status: 'ready',
    canGenerate: true,
    targetCountryCode,
    observedCountryCode,
    effectiveCountryCode: observedCountryCode,
    warnings: []
  }
}
