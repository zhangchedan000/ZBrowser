import type { IdentityConfigSource } from './types'
import type { AIDiagnosisContext, FingerprintComponent } from './fingerprint-health-model'

export interface FingerprintRepairProposal {
  issue: string
  signalKey?: string
  cause: string
  actions: string[]
  affectedComponent: FingerprintComponent
  configSources: IdentityConfigSource[]
  protectedByUserOverride: boolean
  automatedRepairAllowed: boolean
  requiresUserConfirmation: boolean
}

function componentActions(component: FingerprintComponent): string[] {
  switch (component) {
    case 'gpu':
      return [
        '检查 GPU Persona 与 Runtime GPU 信息一致性',
        '重新检测 WebGL/WebGPU 渲染环境'
      ]
    case 'network':
      return [
        '检查代理出口与网络身份配置',
        '重新验证区域与连接状态'
      ]
    case 'locale':
      return [
        '检查语言、时区和区域配置',
        '确认用户自定义设置'
      ]
    case 'hardware':
      return [
        '检查 Hardware Persona 参数',
        '重新执行硬件一致性检测'
      ]
    case 'rendering':
      return [
        '检查 Canvas、Audio、Font 渲染参数',
        '重新生成渲染诊断'
      ]
    default:
      return [
        '重新执行浏览器环境诊断'
      ]
  }
}

export function buildRepairProposals(
  context: AIDiagnosisContext
): FingerprintRepairProposal[] {
  if (context.issues.length) {
    return context.issues.map((issue) => {
      const configSources = [...new Set(issue.configReferences.map((reference) => reference.source))]
      const protectedByUserOverride = issue.repairPolicy === 'suggest_only'
      const actions = componentActions(issue.component)
      return {
        issue: issue.evidence,
        signalKey: issue.key,
        cause: 'Runtime fingerprint signal is inconsistent with expected identity',
        actions: protectedByUserOverride
          ? [...actions, '保留用户手动配置；仅给出修改建议，不由 AI 自动覆盖']
          : actions,
        affectedComponent: issue.component,
        configSources,
        protectedByUserOverride,
        automatedRepairAllowed: !protectedByUserOverride,
        requiresUserConfirmation: true
      }
    })
  }

  return context.risks.map((risk) => {
    const rawComponent = risk.split(':')[0] ?? 'browser'
    const affectedComponent: FingerprintComponent = ['browser', 'hardware', 'gpu', 'rendering', 'network', 'locale'].includes(rawComponent)
      ? rawComponent as FingerprintComponent
      : 'browser'

    return {
      issue: risk,
      cause: 'Runtime fingerprint signal is inconsistent with expected identity',
      actions: componentActions(affectedComponent),
      affectedComponent,
      configSources: [],
      protectedByUserOverride: false,
      automatedRepairAllowed: true,
      requiresUserConfirmation: true
    }
  })
}
