import { describe, expect, it } from 'vitest'
import type { BrowserProfileView, IdentitySelfHealingSummary } from '../../shared/types'
import { classifySelfHealingAttention, profileHasSelfHealingAttention, selfHealingAttentionItems } from './self-healing-attention'

function profile(id: string): BrowserProfileView {
  return { id, name: id, status: 'closed' } as BrowserProfileView
}

function state(patch: Partial<IdentitySelfHealingSummary> = {}): IdentitySelfHealingSummary {
  return {
    mode: 'assisted',
    decision: 'suggest',
    reason: 'needs review',
    pending: false,
    attemptsInWindow: 0,
    consecutiveFailures: 0,
    ...patch
  }
}

describe('self-healing attention classification', () => {
  it('prioritizes blocked and manual-review environments', () => {
    const blocked = classifySelfHealingAttention(profile('blocked'), state({
      decision: 'blocked',
      reason: 'loop guard'
    }))
    const manual = classifySelfHealingAttention(profile('manual'), state({
      pending: true,
      pendingStrategyKind: 'manual_review',
      pendingReason: 'inspect identity'
    }))

    expect(blocked).toMatchObject({ level: 'critical', reason: 'loop guard' })
    expect(manual).toMatchObject({ level: 'critical', reason: 'inspect identity' })
  })

  it('exposes a boolean predicate for main-workspace attention filtering', () => {
    const item = profile('profile')
    expect(profileHasSelfHealingAttention(item, state({
      pending: true,
      pendingStrategyKind: 'switch_proxy',
      decision: 'suggest'
    }))).toBe(true)
    expect(profileHasSelfHealingAttention(item, state({
      mode: 'auto',
      pending: true,
      pendingStrategyKind: 'repair_configuration',
      decision: 'auto_execute'
    }))).toBe(false)
    expect(profileHasSelfHealingAttention(item, undefined)).toBe(false)
  })

  it('ignores healthy low-risk auto work and sorts critical attention first', () => {
    const profiles = [profile('low'), profile('warning'), profile('critical')]
    const states = {
      low: state({
        mode: 'auto',
        decision: 'auto_execute',
        pending: true,
        pendingStrategyKind: 'repair_configuration'
      }),
      warning: state({
        decision: 'suggest',
        pending: true,
        pendingStrategyKind: 'switch_proxy',
        pendingDetectedAt: '2026-09-24T10:00:00.000Z'
      }),
      critical: state({
        decision: 'blocked',
        reason: 'loop guard',
        lastAttemptAt: '2026-09-24T09:00:00.000Z'
      })
    }

    const items = selfHealingAttentionItems(profiles, states, (item) => state({ reason: item.name }))
    expect(items.map((item) => item.profile.id)).toEqual(['critical', 'warning'])
  })
})
