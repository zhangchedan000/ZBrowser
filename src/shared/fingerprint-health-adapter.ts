import type { FingerprintHealthSignal } from './fingerprint-health-model'

export interface DiagnosticCheckInput {
  key: string
  status: 'pass' | 'warning' | 'error'
  message: string
  value?: unknown
  expected?: unknown
}

function resolveComponent(key: string): FingerprintHealthSignal['component'] {
  if (key.includes('gpu') || key.includes('webgl') || key.includes('webgpu')) return 'gpu'
  if (key.includes('cpu') || key.includes('memory') || key.includes('screen')) return 'hardware'
  if (key.includes('timezone') || key.includes('language')) return 'locale'
  if (key.includes('proxy') || key.includes('network') || key.includes('ip')) return 'network'
  if (key.includes('canvas') || key.includes('audio') || key.includes('font')) return 'rendering'
  return 'browser'
}

function resolveWeight(status: DiagnosticCheckInput['status']): number {
  if (status === 'error') return 25
  if (status === 'warning') return 10
  return 0
}

export function diagnosticChecksToHealthSignals(
  checks: DiagnosticCheckInput[]
): FingerprintHealthSignal[] {
  return checks
    .filter((check) => check.status !== 'pass')
    .map((check) => ({
      component: resolveComponent(check.key),
      key: check.key,
      value: check.value,
      expected: check.expected,
      weight: resolveWeight(check.status),
      confidence: check.status === 'error' ? 1 : 0.6,
      impact: check.status === 'error' ? 'error' : 'warning',
      evidence: check.message
    }))
}
