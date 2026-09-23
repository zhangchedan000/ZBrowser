import type { FingerprintRiskLevel } from './fingerprint-health-model'
import type { IdentityDriftReport } from './identity-baseline-model'

export interface IdentityHealthTrendRecord {
  checkedAt: string
  baselineId: string
  score: number
  risk: FingerprintRiskLevel
  driftDetected: boolean
  driftSeverity: IdentityDriftReport['severity']
  changeCount: number
}

export interface IdentityHealthTrendSummary {
  sampleCount: number
  currentScore: number
  previousScore?: number
  delta?: number
  direction: 'improving' | 'stable' | 'degrading' | 'unknown'
  currentRisk: FingerprintRiskLevel
  criticalSamples: number
  driftSamples: number
  latestCheckedAt: string
}

export function summarizeIdentityHealthTrend(
  records: IdentityHealthTrendRecord[]
): IdentityHealthTrendSummary | undefined {
  if (!records.length) return undefined

  const latest = records[0]
  const previous = records[1]
  const delta = previous ? latest.score - previous.score : undefined
  const direction = delta === undefined
    ? 'unknown'
    : delta > 0
      ? 'improving'
      : delta < 0
        ? 'degrading'
        : 'stable'

  return {
    sampleCount: records.length,
    currentScore: latest.score,
    previousScore: previous?.score,
    delta,
    direction,
    currentRisk: latest.risk,
    criticalSamples: records.filter((record) => record.risk === 'critical').length,
    driftSamples: records.filter((record) => record.driftDetected).length,
    latestCheckedAt: latest.checkedAt
  }
}
