import { describe, expect, it } from 'vitest'
import { summarizeIdentityHealthTrend, type IdentityHealthTrendRecord } from './identity-health-trend'

function record(score: number, risk: IdentityHealthTrendRecord['risk'], checkedAt: string): IdentityHealthTrendRecord {
  return {
    checkedAt,
    baselineId: 'baseline-1',
    score,
    risk,
    driftDetected: score < 100,
    driftSeverity: risk,
    changeCount: score < 100 ? 1 : 0
  }
}

describe('identity health trend', () => {
  it('returns undefined without samples', () => {
    expect(summarizeIdentityHealthTrend([])).toBeUndefined()
  })

  it('detects degrading and improving score movement', () => {
    const degrading = summarizeIdentityHealthTrend([
      record(40, 'high', '2026-09-23T10:00:00.000Z'),
      record(100, 'low', '2026-09-23T09:00:00.000Z')
    ])
    expect(degrading?.direction).toBe('degrading')
    expect(degrading?.delta).toBe(-60)

    const improving = summarizeIdentityHealthTrend([
      record(100, 'low', '2026-09-23T11:00:00.000Z'),
      record(40, 'high', '2026-09-23T10:00:00.000Z')
    ])
    expect(improving?.direction).toBe('improving')
    expect(improving?.delta).toBe(60)
  })

  it('counts critical and drift samples', () => {
    const result = summarizeIdentityHealthTrend([
      record(30, 'critical', '2026-09-23T11:00:00.000Z'),
      record(60, 'high', '2026-09-23T10:00:00.000Z'),
      record(100, 'low', '2026-09-23T09:00:00.000Z')
    ])

    expect(result?.sampleCount).toBe(3)
    expect(result?.criticalSamples).toBe(1)
    expect(result?.driftSamples).toBe(2)
  })
})
