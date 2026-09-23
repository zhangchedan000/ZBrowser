import type {
  AIDiagnosisContext,
  AIDiagnosisIssue,
  FingerprintComponent,
  FingerprintHealthModel
} from './fingerprint-health-model'

function suggestedAction(component: FingerprintComponent): string {
  switch (component) {
    case 'gpu':
      return '检查 GPU Persona 与实际运行环境是否一致'
    case 'network':
      return '检查代理出口、网络身份和区域配置'
    case 'locale':
      return '检查时区、语言和地区设置一致性'
    case 'hardware':
      return '检查硬件 Persona 与 Runtime 数据匹配情况'
    case 'rendering':
      return '检查 Canvas、Audio、Font 等渲染环境'
    default:
      return '检查浏览器版本和身份配置'
  }
}

export function buildAIDiagnosisContext(
  model: FingerprintHealthModel
): AIDiagnosisContext {
  const issues: AIDiagnosisIssue[] = model.components.flatMap((component) =>
    component.signals.map((signal) => {
      const configReferences = signal.configReferences ?? []
      const protectedByUserOverride = configReferences.some((reference) => reference.source === 'user')
      return {
        component: component.component,
        key: signal.key,
        evidence: signal.evidence,
        configReferences,
        repairPolicy: protectedByUserOverride ? 'suggest_only' : 'confirm_apply'
      }
    })
  )

  const risks = model.components
    .filter((component) => component.risk !== 'low')
    .map((component) => {
      const signal = component.signals[0]
      return `${component.component}: ${signal?.evidence ?? 'health degradation detected'}`
    })

  const suggestedActions = [...new Set(
    model.components
      .filter((component) => component.risk !== 'low')
      .map((component) => suggestedAction(component.component))
  )]

  return {
    summary: `Fingerprint Health score ${model.score}, risk ${model.risk}`,
    risks,
    suggestedActions,
    requiresUserConfirmation: suggestedActions.length > 0,
    issues,
    protectedUserOverrides: issues.filter((issue) => issue.repairPolicy === 'suggest_only').length
  }
}
