import type { AIDiagnosisContext } from './fingerprint-health-model'

export interface FingerprintRepairProposal {
  issue: string
  cause: string
  actions: string[]
  affectedComponent: string
  requiresUserConfirmation: boolean
}

function componentActions(component: string): string[] {
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
  return context.risks.map((risk) => {
    const component = risk.split(':')[0] ?? 'browser'

    return {
      issue: risk,
      cause: 'Runtime fingerprint signal is inconsistent with expected identity',
      actions: componentActions(component),
      affectedComponent: component,
      requiresUserConfirmation: true
    }
  })
}
