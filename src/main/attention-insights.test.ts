import { describe, expect, it } from 'vitest'
import type { IdentityProfileHealthSummary } from '../shared/identity-profile-health'
import type { AttentionAuditHistoryRecord } from './attention-audit-history'
import { attentionInsights } from './attention-insights'

function audit(
  index: number,
  profileId: string,
  status: 'completed' | 'confirmation_required' | 'failed'
): AttentionAuditHistoryRecord {
  const startedAt = new Date(Date.UTC(2026, 8, 25, 0, index, 0)).toISOString()
  const completedAt = new Date(Date.UTC(2026, 8, 25, 0, index, 1)).toISOString()
  return {
    id: 'audit-' + index,
    startedAt,
    completedAt,
    total: 1,
    completed: status === 'completed' ? 1 : 0,
    confirmationRequired: status === 'confirmation_required' ? 1 : 0,
    failed: status === 'failed' ? 1 : 0,
    results: [{
      priority: 1,
      profileId,
      action: status === 'confirmation_required' ? 'confirm_self_healing' : 'run_identity_check',
      risk: status === 'confirmation_required' ? 'confirmation_required' : 'policy_gated',
      status,
      startedAt,
      completedAt,
      message: 'test'
    }]
  }
}

describe('attention insights', () => {
  it('marks repeated failures as critical', () => {
    const items = attentionInsights(
      [{ id: 'failed', serialNumber: 7, name: 'Failed profile' }],
      [audit(3, 'failed', 'failed'), audit(2, 'failed', 'completed'), audit(1, 'failed', 'failed')],
      {}
    )

    expect(items).toEqual([
      expect.objectContaining({
        profileId: 'failed',
        level: 'critical',
        failures: 2,
        appearances: 3,
        signals: expect.arrayContaining(['repeated_failure', 'repeated_attention'])
      })
    ])
  })

  it('flags profiles that repeatedly require user confirmation', () => {
    const items = attentionInsights(
      [{ id: 'confirm', serialNumber: 2, name: 'Confirm profile' }],
      [
        audit(4, 'confirm', 'confirmation_required'),
        audit(3, 'confirm', 'confirmation_required'),
        audit(2, 'confirm', 'completed'),
        audit(1, 'confirm', 'confirmation_required')
      ],
      {}
    )

    expect(items[0]).toMatchObject({
      level: 'warning',
      confirmationRequired: 3,
      signals: expect.arrayContaining(['repeated_confirmation', 'repeated_attention'])
    })
  })

  it('detects degrading Identity Health even without repeated audit failures', () => {
    const health: Record<string, IdentityProfileHealthSummary> = {
      degrading: {
        state: 'attention',
        score: 68,
        trend: {
          sampleCount: 3,
          currentScore: 68,
          previousScore: 77,
          delta: -9,
          direction: 'degrading',
          currentRisk: 'medium',
          criticalSamples: 0,
          driftSamples: 2,
          latestCheckedAt: '2026-09-25T00:00:00.000Z'
        }
      }
    }

    const items = attentionInsights(
      [{ id: 'degrading', serialNumber: 1, name: 'Degrading profile' }],
      [],
      health
    )

    expect(items[0]).toMatchObject({
      profileId: 'degrading',
      level: 'warning',
      identityScore: 68,
      identityDelta: -9,
      signals: ['identity_degrading']
    })
  })

  it('ignores one-off healthy history', () => {
    expect(attentionInsights(
      [{ id: 'ok', serialNumber: 1, name: 'OK' }],
      [audit(1, 'ok', 'completed')],
      { ok: { state: 'healthy', score: 98 } }
    )).toEqual([])
  })
})
