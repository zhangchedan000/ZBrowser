import type { FingerprintRiskLevel } from './fingerprint-health-model'
import type { IdentityDriftReport } from './identity-baseline-model'
import { summarizeIdentityHealthTrend, type IdentityHealthTrendRecord, type IdentityHealthTrendSummary } from './identity-health-trend'

export type IdentityProfileHealthState = 'healthy' | 'attention' | 'critical' | 'unknown'

export interface IdentityProfileHealthSummary {
  state: IdentityProfileHealthState
  score?: number
  risk?: FingerprintRiskLevel
  driftDetected?: boolean
  driftSeverity?: IdentityDriftReport['severity']
  changeCount?: number
  checkedAt?: string
  trend?: IdentityHealthTrendSummary
}

export function summarizeIdentityProfileHealth(
  records: IdentityHealthTrendRecord[]
): IdentityProfileHealthSummary {
  if (!records.length) return { state: 'unknown' }

  const latest = records[0]
  const state: IdentityProfileHealthState =
    latest.risk === 'critical' || latest.driftSeverity === 'critical'
      ? 'critical'
      : latest.driftDetected || latest.risk === 'high' || latest.risk === 'medium'
        ? 'attention'
        : 'healthy'

  return {
    state,
    score: latest.score,
    risk: latest.risk,
    driftDetected: latest.driftDetected,
    driftSeverity: latest.driftSeverity,
    changeCount: latest.changeCount,
    checkedAt: latest.checkedAt,
    trend: summarizeIdentityHealthTrend(records)
  }
}
