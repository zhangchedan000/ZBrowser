import type {
  BrowserProfile,
  FingerprintRuntimeDiagnosticReport,
  IdentitySelfHealingMode,
  ProfileEnvironmentType
} from './types'
import type { IdentityDriftReport } from './identity-baseline-model'
import type { FingerprintRiskLevel } from './fingerprint-health-model'
import type { IdentityRepairStrategy, IdentityRepairStrategyKind } from './identity-repair-strategy'

export type IdentitySelfHealingPolicyAction = 'none' | 'suggest' | 'execute'

export interface IdentitySelfHealingPolicyDecision {
  action: IdentitySelfHealingPolicyAction
  risk: 'low' | 'medium' | 'high'
  reason: string
}

export interface IdentitySelfHealingPolicyInput {
  mode: IdentitySelfHealingMode
  environmentType: ProfileEnvironmentType
  strategy?: IdentityRepairStrategy
  driftSeverity?: IdentityDriftReport['severity']
  healthRisk?: FingerprintRiskLevel
}

const LOW_RISK_CONFIG_SECTIONS = new Set(['locale', 'browser'])

function highRuntimeRisk(input: IdentitySelfHealingPolicyInput): boolean {
  return input.driftSeverity === 'high'
    || input.driftSeverity === 'critical'
    || input.healthRisk === 'high'
    || input.healthRisk === 'critical'
}

export function identityRepairStrategySignature(strategy: IdentityRepairStrategy): string {
  return [
    strategy.kind,
    strategy.targetCountryCode ?? '',
    strategy.candidateProxy?.id ?? '',
    [...strategy.affectedSections].sort().join(',')
  ].join('|')
}

export function evaluateIdentitySelfHealingPolicy(input: IdentitySelfHealingPolicyInput): IdentitySelfHealingPolicyDecision {
  const strategy = input.strategy
  if (!strategy || strategy.kind === 'none') {
    return { action: 'none', risk: 'low', reason: '当前没有需要执行的 Identity Repair Strategy' }
  }

  if (input.mode === 'manual') {
    return { action: 'none', risk: 'low', reason: 'Self-Healing 为 Manual，仅记录诊断结果' }
  }

  if (input.mode === 'assisted') {
    return {
      action: 'suggest',
      risk: strategy.kind === 'regenerate_identity' || strategy.kind === 'manual_review' ? 'high' : 'medium',
      reason: 'Self-Healing 为 Assisted，需要用户确认后执行恢复策略'
    }
  }

  if (strategy.kind === 'manual_review') {
    return { action: 'suggest', risk: 'high', reason: '该问题需要人工确认，Auto 模式不会越权执行' }
  }
  if (!strategy.automaticActionAvailable) {
    return { action: 'suggest', risk: 'medium', reason: '当前缺少可自动执行的候选资源' }
  }
  if (strategy.kind === 'regenerate_identity') {
    return { action: 'suggest', risk: 'high', reason: '完整 Identity 重生成属于高风险动作，Auto 模式仍要求用户确认' }
  }
  if (strategy.kind === 'switch_proxy') {
    if (input.environmentType !== 'temporary') {
      return { action: 'suggest', risk: 'high', reason: '账号环境禁止无人值守自动换代理，需用户确认' }
    }
    if (highRuntimeRisk(input)) {
      return { action: 'suggest', risk: 'high', reason: '当前身份风险较高，自动换代理需要用户确认' }
    }
    return { action: 'execute', risk: 'medium', reason: '临时环境可自动切换到符合 Identity Intent 的已验证代理' }
  }
  if (strategy.kind === 'replace_baseline') {
    return { action: 'execute', risk: 'low', reason: 'Runtime 已验证与 Identity Intent 对齐，可安全换代 Baseline' }
  }
  if (strategy.kind === 'repair_configuration') {
    if (highRuntimeRisk(input)) {
      return { action: 'suggest', risk: 'high', reason: '当前身份风险较高，配置修复需要用户确认' }
    }
    if (strategy.affectedSections.some((section) => !LOW_RISK_CONFIG_SECTIONS.has(section))) {
      return { action: 'suggest', risk: 'medium', reason: '修复涉及网络或硬件身份，Auto 模式不会无人值守修改' }
    }
    return { action: 'execute', risk: 'low', reason: '仅涉及语言/时区或浏览器身份的低风险配置，可自动最小修复' }
  }

  return { action: 'suggest', risk: 'medium', reason: '当前策略未列入无人值守白名单，需要用户确认' }
}

export function evaluateProfileSelfHealingPolicy(
  profile: Pick<BrowserProfile, 'environmentType' | 'identityIntent'>,
  report: FingerprintRuntimeDiagnosticReport
): IdentitySelfHealingPolicyDecision {
  return evaluateIdentitySelfHealingPolicy({
    mode: profile.identityIntent?.selfHealingMode ?? 'assisted',
    environmentType: profile.environmentType ?? 'account',
    strategy: report.identityRepairStrategy,
    driftSeverity: report.identityDrift?.severity,
    healthRisk: report.identityHealth?.risk
  })
}

export function autoPolicyAllowsStrategy(
  profile: Pick<BrowserProfile, 'environmentType' | 'identityIntent'>,
  report: FingerprintRuntimeDiagnosticReport,
  strategyKind: IdentityRepairStrategyKind
): boolean {
  if (report.identityRepairStrategy?.kind !== strategyKind) return false
  return evaluateProfileSelfHealingPolicy(profile, report).action === 'execute'
}
