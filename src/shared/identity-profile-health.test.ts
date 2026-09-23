import { describe, expect, it } from 'vitest'
import type { IdentityHealthTrendRecord } from './identity-health-trend'
import { summarizeIdentityProfileHealth } from './identity-profile-health'

function record(
  score: number,
  risk: IdentityHealthTrendRecord['risk'],
  driftDetected = score < 100,
  driftSeverity: IdentityHealthTrendRecord['driftSeverity'] = risk
): IdentityHealthTrendRecord {
  return {
    checkedAt: '2026-09-23T14:00:00.000Z',
    baselineId: 'baseline-1',
    score,
    risk,
    driftDetected,
    driftSeverity,
    changeCount: driftDetected ? 1 : 0
  }
}

describe('identity profile health summary', () => {
  it('returns unknown when the profile has never been monitored', () => {
    expect(summarizeIdentityProfileHealth([])).toEqual({ state: 'unknown' })
  })

  it('maps a stable low-risk identity to healthy', () => {
    const summary = summarizeIdentityProfileHealth([record(100, 'low', false, 'low')])
    expect(summary.state).toBe('healthy')
    expect(summary.score).toBe(100)
    expect(summary.driftDetected).toBe(false)
  })

  it('maps medium and high risk drift to attention', () => {
    expect(summarizeIdentityProfileHealth([record(78, 'medium')]).state).toBe('attention')
    expect(summarizeIdentityProfileHealth([record(55, 'high')]).state).toBe('attention')
  })

  it('maps critical drift to critical and exposes trend', () => {
    const summary = summarizeIdentityProfileHealth([
      record(25, 'critical', true, 'critical'),
      { ...record(100, 'low', false, 'low'), checkedAt: '2026-09-23T13:00:00.000Z' }
    ])
    expect(summary.state).toBe('critical')
    expect(summary.trend?.direction).toBe('degrading')
    expect(summary.trend?.delta).toBe(-75)
  })
})
