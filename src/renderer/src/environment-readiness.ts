import type { FingerprintRuntimeDiagnosticReport, LaunchDiagnosticReport } from '../../shared/types'

export interface EnvironmentReadinessSummary {
  state: 'checking' | 'ready' | 'attention' | 'blocked'
  title: string
  description: string
  passed: number
  warnings: number
  errors: number
}

interface LocalEnvironmentSummary {
  errors: number
  warnings: number
  ok: number
}

export function summarizeEnvironmentReadiness(
  local: LocalEnvironmentSummary,
  launch?: LaunchDiagnosticReport,
  runtime?: FingerprintRuntimeDiagnosticReport,
  launchError?: string
): EnvironmentReadinessSummary {
  const launchErrors = launch?.checks.filter((check) => check.status === 'error').length ?? 0
  const launchWarnings = launch?.checks.filter((check) => check.status === 'warning').length ?? 0
  const launchPasses = launch?.checks.filter((check) => check.status === 'pass').length ?? 0

  const runtimeErrors = runtime
    ? Math.max(runtime.checks.filter((check) => check.status === 'error').length, runtime.ready ? 0 : 1)
    : 0
  const runtimeWarnings = runtime
    ? runtime.checks.filter((check) => check.status === 'warning').length
    : 1
  const runtimePasses = runtime?.checks.filter((check) => check.status === 'pass').length ?? 0

  const errors = local.errors + launchErrors + runtimeErrors + (launchError ? 1 : 0)
  const warnings = local.warnings + launchWarnings + runtimeWarnings
  const passed = local.ok + launchPasses + runtimePasses

  if (!launch && !launchError) {
    return {
      state: 'checking',
      title: '正在检查环境是否可以启动',
      description: '正在核对浏览器内核、代理网络、数据目录和身份配置。',
      passed,
      warnings,
      errors
    }
  }

  if (errors > 0 || launch?.ready === false) {
    return {
      state: 'blocked',
      title: '当前环境暂不建议启动',
      description: `发现 ${Math.max(errors, 1)} 项阻止问题。请先处理红色项目，再启动正式业务页面。`,
      passed,
      warnings,
      errors: Math.max(errors, 1)
    }
  }

  if (warnings > 0) {
    return {
      state: 'attention',
      title: `环境可以启动，但有 ${warnings} 项需要确认`,
      description: runtime
        ? '关键启动条件已通过；建议确认提醒项后再用于长期账号环境。'
        : '启动条件已通过，但尚未完成实际浏览器指纹验证，建议点击“启动并读取实际指纹”。',
      passed,
      warnings,
      errors: 0
    }
  }

  return {
    state: 'ready',
    title: '环境已准备好，可以启动',
    description: '浏览器内核、代理/网络、配置一致性和实际指纹检查均未发现阻止项。',
    passed,
    warnings: 0,
    errors: 0
  }
}
