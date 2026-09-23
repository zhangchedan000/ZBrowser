import type { FingerprintConsistencyReport } from './fingerprint-consistency'

export type FingerprintHealthLevel = 'healthy' | 'attention' | 'critical'

export interface FingerprintHealthReport {
  score: number
  level: FingerprintHealthLevel
  consistency: FingerprintConsistencyReport
  summary: string
}

export function buildFingerprintHealthReport(
  consistency: FingerprintConsistencyReport
): FingerprintHealthReport {
  const score = Math.max(0, Math.min(100, consistency.score))

  let level: FingerprintHealthLevel = 'healthy'
  if (score < 80) level = 'attention'
  if (score < 50) level = 'critical'

  return {
    score,
    level,
    consistency,
    summary:
      level === 'healthy'
        ? 'Fingerprint identity is consistent'
        : level === 'attention'
          ? 'Fingerprint identity requires review'
          : 'Fingerprint identity has critical conflicts'
  }
}
