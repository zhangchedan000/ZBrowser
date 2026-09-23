import type { LaunchDiagnosticCheck } from './types'

export type FingerprintHealthLevel = 'healthy' | 'warning' | 'critical'

export interface FingerprintHealthIssue {
  key: string
  severity: LaunchDiagnosticCheck['status']
  message: string
  repairHint: string
}

export interface FingerprintHealthReport {
  score: number
  level: FingerprintHealthLevel
  issues: FingerprintHealthIssue[]
  generatedAt: string
}

function scoreCheck(check: LaunchDiagnosticCheck): number {
  if (check.status === 'error') return -20
  if (check.status === 'warning') return -5
  return 0
}

function repairHint(check: LaunchDiagnosticCheck): string {
  if (check.key.includes('gpu')) return '检查 GPU Persona 与实际运行环境是否一致'
  if (check.key.includes('timezone')) return '检查网络身份、代理出口和时区配置'
  if (check.key.includes('language')) return '检查语言与地区配置是否匹配'
  return '检查该指纹参数的配置来源并重新执行诊断'
}

export function buildFingerprintHealthReport(checks: LaunchDiagnosticCheck[]): FingerprintHealthReport {
  let score = 100

  const issues = checks
    .filter((check) => check.status !== 'pass')
    .map((check) => {
      score += scoreCheck(check)
      return {
        key: check.key,
        severity: check.status,
        message: check.message,
        repairHint: repairHint(check)
      }
    })

  score = Math.max(0, Math.min(100, score))

  return {
    score,
    level: score < 60 ? 'critical' : score < 85 ? 'warning' : 'healthy',
    issues,
    generatedAt: new Date().toISOString()
  }
}
