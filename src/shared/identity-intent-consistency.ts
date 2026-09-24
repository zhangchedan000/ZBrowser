import type { IdentityBaselineSnapshot } from './identity-baseline-model'
import { normalizeIdentityIntent } from './identity-intent'
import type { IdentityIntent, LaunchDiagnosticCheck, ProxyCheckSummary, ProxyProtocol } from './types'

export type IdentityIntentConsistencyStatus = 'not_configured' | 'aligned' | 'unverified' | 'mismatch'

export interface IdentityIntentConsistencyInput {
  intent?: IdentityIntent
  proxyProtocol: ProxyProtocol
  proxyCheck?: ProxyCheckSummary
  runtimeSnapshot?: IdentityBaselineSnapshot
  baselineSnapshot?: IdentityBaselineSnapshot
}
export interface IdentityIntentConsistency {
  status: IdentityIntentConsistencyStatus
  targetCountryCode?: string
  proxyCountryCode?: string
  runtimeCountryCode?: string
  baselineCountryCode?: string
  warnings: string[]
}
function countryCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined
}
export function evaluateIdentityIntentConsistency(input: IdentityIntentConsistencyInput): IdentityIntentConsistency {
  const targetCountryCode = normalizeIdentityIntent(input.intent).targetCountryCode
  if (!targetCountryCode) return { status: 'not_configured', warnings: [] }
  const proxyCountryCode = countryCode(input.proxyCheck?.countryCode)
  const runtimeCountryCode = countryCode(input.runtimeSnapshot?.network.countryCode)
  const baselineCountryCode = countryCode(input.baselineSnapshot?.network.countryCode)
  const warnings: string[] = []
  if (input.proxyProtocol === 'direct') {
    if (runtimeCountryCode && runtimeCountryCode !== targetCountryCode) {
      warnings.push(`目标国家 ${targetCountryCode} 与 Runtime 网络国家 ${runtimeCountryCode} 不一致`)
      return { status: 'mismatch', targetCountryCode, proxyCountryCode, runtimeCountryCode, baselineCountryCode, warnings }
    }
    if (!runtimeCountryCode) warnings.push(`直连模式无法从当前 Runtime 证据确认目标国家 ${targetCountryCode}`)
    if (baselineCountryCode && baselineCountryCode !== targetCountryCode) {
      warnings.push(`Baseline 网络国家 ${baselineCountryCode} 与目标国家 ${targetCountryCode} 不一致`)
    }
    return { status: warnings.length ? 'unverified' : 'aligned', targetCountryCode, proxyCountryCode, runtimeCountryCode, baselineCountryCode, warnings }
  }
  if (!input.proxyCheck?.ok || !proxyCountryCode) {
    warnings.push('代理出口尚未提供可信国家证据')
    return { status: 'mismatch', targetCountryCode, proxyCountryCode, runtimeCountryCode, baselineCountryCode, warnings }
  }
  if (input.proxyCheck.geoConfidence === 'conflict') {
    warnings.push('代理 GeoIP 数据源存在冲突，不能确认 Identity Intent')
    return { status: 'mismatch', targetCountryCode, proxyCountryCode, runtimeCountryCode, baselineCountryCode, warnings }
  }
  if (proxyCountryCode !== targetCountryCode) warnings.push(`目标国家 ${targetCountryCode} 与代理出口 ${proxyCountryCode} 不一致`)
  if (!runtimeCountryCode) warnings.push('Runtime Identity Snapshot 缺少网络国家证据')
  else if (runtimeCountryCode !== targetCountryCode) warnings.push(`目标国家 ${targetCountryCode} 与 Runtime 网络国家 ${runtimeCountryCode} 不一致`)
  if (baselineCountryCode && baselineCountryCode !== targetCountryCode) warnings.push(`Baseline 网络国家 ${baselineCountryCode} 与目标国家 ${targetCountryCode} 不一致`)
  return { status: warnings.length ? 'mismatch' : 'aligned', targetCountryCode, proxyCountryCode, runtimeCountryCode, baselineCountryCode, warnings }
}
export function identityIntentConsistencyChecks(consistency: IdentityIntentConsistency): LaunchDiagnosticCheck[] {
  if (!consistency.targetCountryCode) return []
  const target = consistency.targetCountryCode
  const checks: LaunchDiagnosticCheck[] = []
  if (consistency.proxyCountryCode) checks.push({
    key: 'identity-intent-proxy-country', label: 'Identity Intent · 代理国家',
    status: consistency.proxyCountryCode === target ? 'pass' : 'error',
    message: consistency.proxyCountryCode === target ? `代理出口国家 ${consistency.proxyCountryCode} 与目标国家 ${target} 一致` : `代理出口国家 ${consistency.proxyCountryCode} 与目标国家 ${target} 不一致`
  })
  else checks.push({
    key: 'identity-intent-proxy-country', label: 'Identity Intent · 代理国家',
    status: consistency.status === 'mismatch' ? 'error' : 'warning',
    message: consistency.status === 'mismatch' ? `缺少可信代理国家证据，无法验证目标国家 ${target}` : `当前未通过代理国家证据验证目标国家 ${target}`
  })
  if (consistency.runtimeCountryCode) checks.push({
    key: 'identity-intent-runtime-country', label: 'Identity Intent · Runtime 国家',
    status: consistency.runtimeCountryCode === target ? 'pass' : 'error',
    message: consistency.runtimeCountryCode === target ? `Runtime 网络国家 ${consistency.runtimeCountryCode} 与目标国家 ${target} 一致` : `Runtime 网络国家 ${consistency.runtimeCountryCode} 与目标国家 ${target} 不一致`
  })
  else checks.push({
    key: 'identity-intent-runtime-country', label: 'Identity Intent · Runtime 国家',
    status: consistency.status === 'mismatch' ? 'error' : 'warning',
    message: `Runtime 暂无可验证目标国家 ${target} 的网络国家证据`
  })
  if (consistency.baselineCountryCode) checks.push({
    key: 'identity-intent-baseline-country', label: 'Identity Intent · Baseline 国家',
    status: consistency.baselineCountryCode === target ? 'pass' : 'warning',
    message: consistency.baselineCountryCode === target ? `Baseline 网络国家 ${consistency.baselineCountryCode} 与目标国家 ${target} 一致` : `Baseline 网络国家 ${consistency.baselineCountryCode} 与目标国家 ${target} 不一致；通过 Runtime Verify 后应换代`
  })
  return checks
}
