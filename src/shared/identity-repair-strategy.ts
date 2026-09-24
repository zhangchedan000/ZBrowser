import type { IdentityBaselineStatus, IdentityDriftReport } from './identity-baseline-model'
import type { AIDiagnosisContext } from './fingerprint-health-model'
import type { IdentityIntentConsistency } from './identity-intent-consistency'
import type { IdentityConfigSection } from './types'

export type IdentityRepairStrategyKind =
  | 'none'
  | 'switch_proxy'
  | 'regenerate_identity'
  | 'repair_configuration'
  | 'replace_baseline'
  | 'manual_review'

export interface IdentityRepairProxyCandidate {
  id: string
  name: string
  countryCode: string
  score: number
}

export interface IdentityRepairStrategy {
  kind: IdentityRepairStrategyKind
  reason: string
  affectedSections: IdentityConfigSection[]
  requiresUserConfirmation: boolean
  automaticActionAvailable: boolean
  targetCountryCode?: string
  candidateProxy?: IdentityRepairProxyCandidate
}

export interface IdentityRepairStrategyInput {
  consistency?: IdentityIntentConsistency
  drift?: IdentityDriftReport
  diagnosis?: AIDiagnosisContext
  baselineStatus?: IdentityBaselineStatus
  replacementProxy?: IdentityRepairProxyCandidate
}

function sectionsForDrift(drift: IdentityDriftReport | undefined): IdentityConfigSection[] {
  if (!drift?.driftDetected) return []
  const sections = new Set<IdentityConfigSection>()
  for (const change of drift.changes) {
    if (change.component === 'locale') sections.add('locale')
    else if (change.component === 'network') sections.add('network')
    else if (change.component === 'browser') sections.add('browser')
    else sections.add('fingerprint')
  }
  return [...sections]
}

function sectionsForDiagnosis(diagnosis: AIDiagnosisContext | undefined): IdentityConfigSection[] {
  return [...new Set((diagnosis?.issues ?? []).flatMap((issue) =>
    issue.configReferences.filter((reference) => issue.repairPolicy === 'confirm_apply').map((reference) => reference.section)
  ))]
}

export function resolveIdentityRepairStrategy(input: IdentityRepairStrategyInput): IdentityRepairStrategy {
  const consistency = input.consistency
  const target = consistency?.targetCountryCode
  const proxyCountry = consistency?.proxyCountryCode
  const runtimeCountry = consistency?.runtimeCountryCode
  const baselineCountry = consistency?.baselineCountryCode

  if (
    target
    && baselineCountry
    && baselineCountry !== target
    && (!proxyCountry || proxyCountry === target)
    && runtimeCountry === target
  ) {
    return {
      kind: 'replace_baseline',
      reason: `当前 Runtime 已符合目标国家 ${target}，但 Baseline 仍记录 ${baselineCountry}，应在验证通过后换代 Baseline`,
      affectedSections: ['network'],
      requiresUserConfirmation: false,
      automaticActionAvailable: true,
      targetCountryCode: target
    }
  }

  if (consistency?.status === 'mismatch' && target) {
    if (!proxyCountry || proxyCountry !== target || (runtimeCountry && runtimeCountry !== target)) {
      return {
        kind: 'switch_proxy',
        reason: proxyCountry
          ? `目标国家 ${target} 与当前代理/Runtime 国家 ${proxyCountry} 不一致，应优先修复 Network Identity`
          : `目标国家 ${target} 缺少可信代理国家证据，应优先更换或重新检测代理`,
        affectedSections: ['network'],
        requiresUserConfirmation: true,
        automaticActionAvailable: Boolean(input.replacementProxy),
        targetCountryCode: target,
        candidateProxy: input.replacementProxy
      }
    }
    return {
      kind: 'manual_review',
      reason: consistency.warnings[0] ?? 'Identity Intent 与 Runtime 证据不一致，需要人工确认',
      affectedSections: ['network'],
      requiresUserConfirmation: true,
      automaticActionAvailable: false,
      targetCountryCode: target
    }
  }

  const driftSections = sectionsForDrift(input.drift)
  if (input.drift?.driftDetected) {
    const components = new Set(input.drift.changes.map((change) => change.component))
    if (components.has('network') && target) {
      return {
        kind: 'switch_proxy',
        reason: '检测到 Network Identity 漂移，应优先恢复目标国家的可信代理出口',
        affectedSections: ['network'],
        requiresUserConfirmation: true,
        automaticActionAvailable: Boolean(input.replacementProxy),
        targetCountryCode: target,
        candidateProxy: input.replacementProxy
      }
    }
    if (components.has('hardware') || components.has('gpu') || components.has('rendering')) {
      return {
        kind: 'regenerate_identity',
        reason: '检测到硬件/GPU/渲染身份漂移，局部修改可能破坏 Persona 一致性，应重新生成成套 Identity',
        affectedSections: [...new Set<IdentityConfigSection>(['fingerprint', ...driftSections])],
        requiresUserConfirmation: true,
        automaticActionAvailable: true,
        targetCountryCode: target
      }
    }
    return {
      kind: 'repair_configuration',
      reason: '检测到可定位的浏览器/语言/时区配置漂移，可按诊断目标执行最小范围修复',
      affectedSections: driftSections,
      requiresUserConfirmation: true,
      automaticActionAvailable: true,
      targetCountryCode: target
    }
  }

  const diagnosisSections = sectionsForDiagnosis(input.diagnosis)
  if (diagnosisSections.length) {
    return {
      kind: 'repair_configuration',
      reason: '诊断发现可执行的配置修复目标，应按受影响区域进行最小范围修复',
      affectedSections: diagnosisSections,
      requiresUserConfirmation: true,
      automaticActionAvailable: true,
      targetCountryCode: target
    }
  }

  if (input.baselineStatus === 'stale' && consistency?.status !== 'mismatch') {
    return {
      kind: 'replace_baseline',
      reason: '配置变更已被识别为合法 Identity Lifecycle 变更，Runtime Verify 通过后应换代 Baseline',
      affectedSections: [],
      requiresUserConfirmation: false,
      automaticActionAvailable: true,
      targetCountryCode: target
    }
  }

  if (consistency?.status === 'unverified') {
    return {
      kind: 'manual_review',
      reason: consistency.warnings[0] ?? 'Identity Intent 缺少足够运行时证据，暂不自动修改身份',
      affectedSections: [],
      requiresUserConfirmation: true,
      automaticActionAvailable: false,
      targetCountryCode: target
    }
  }

  return {
    kind: 'none',
    reason: 'Identity Intent、Runtime 与 Baseline 当前一致，无需修复',
    affectedSections: [],
    requiresUserConfirmation: false,
    automaticActionAvailable: false,
    targetCountryCode: target
  }
}
