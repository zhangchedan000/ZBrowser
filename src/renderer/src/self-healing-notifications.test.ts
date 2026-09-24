import { describe, expect, it } from 'vitest'
import type { IdentitySelfHealingSummary } from '../../shared/types'
import { selfHealingStateNotices } from './self-healing-notifications'

function state(patch: Partial<IdentitySelfHealingSummary> = {}): IdentitySelfHealingSummary {
  return {
    mode: 'auto',
    decision: 'auto_execute',
    reason: 'test',
    pending: false,
    attemptsInWindow: 0,
    consecutiveFailures: 0,
    ...patch
  }
}

describe('self-healing state notifications', () => {
  it('notifies on a new auto result but ignores existing history on first observation', () => {
    const existing = state({
      lastAttemptAt: '2026-09-24T10:00:00.000Z',
      lastAttemptTrigger: 'auto',
      lastResult: 'completed',
      lastMessage: 'old'
    })
    expect(selfHealingStateNotices({}, { profile: existing })).toEqual([])

    const next = state({
      lastAttemptAt: '2026-09-24T10:05:00.000Z',
      lastAttemptTrigger: 'auto',
      lastResult: 'failed',
      lastMessage: 'runtime verify failed'
    })
    expect(selfHealingStateNotices({ profile: existing }, { profile: next })).toEqual([
      expect.objectContaining({
        profileId: 'profile',
        level: 'error',
        title: 'Auto Self-Healing 修复失败',
        detail: 'runtime verify failed'
      })
    ])
  })

  it('does not duplicate user-confirmed attempt notifications', () => {
    const previous = state()
    const next = state({
      lastAttemptAt: '2026-09-24T10:05:00.000Z',
      lastAttemptTrigger: 'user',
      lastResult: 'completed'
    })
    expect(selfHealingStateNotices({ profile: previous }, { profile: next })).toEqual([])
  })

  it('notifies when loop protection or cooldown becomes active', () => {
    const previous = state()
    expect(selfHealingStateNotices({ profile: previous }, {
      profile: state({ decision: 'blocked', reason: '连续失败达到保护阈值' })
    })).toEqual([
      expect.objectContaining({ level: 'error', title: 'Self-Healing 已触发保护阻止' })
    ])

    expect(selfHealingStateNotices({ profile: previous }, {
      profile: state({ decision: 'cooldown', reason: '等待冷却窗口结束' })
    })).toEqual([
      expect.objectContaining({ level: 'warning', title: 'Self-Healing 已进入冷却' })
    ])
  })
})
