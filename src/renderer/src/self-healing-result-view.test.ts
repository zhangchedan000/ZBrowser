import { describe, expect, it } from 'vitest'
import type { IdentitySelfHealingSummary } from '../../shared/types'
import { selfHealingResultView } from './self-healing-result-view'

function state(patch: Partial<IdentitySelfHealingSummary>): IdentitySelfHealingSummary {
  return {
    mode: 'assisted',
    decision: 'suggest',
    reason: 'test',
    pending: false,
    attemptsInWindow: 0,
    consecutiveFailures: 0,
    ...patch
  }
}

describe('self-healing result view', () => {
  it('maps completed user attempts to a success label', () => {
    const view = selfHealingResultView(state({
      lastAttemptAt: '2026-09-24T10:00:00.000Z',
      lastAttemptTrigger: 'user',
      lastResult: 'completed',
      lastStrategyKind: 'repair_configuration',
      lastMessage: 'done'
    }))
    expect(view).toMatchObject({ color: 'success', text: '人工 · 成功' })
    expect(view?.detail).toContain('repair_configuration')
    expect(view?.detail).toContain('done')
  })

  it('maps auto failures and rollbacks with visible severity', () => {
    expect(selfHealingResultView(state({
      lastAttemptAt: '2026-09-24T10:00:00.000Z',
      lastAttemptTrigger: 'auto',
      lastResult: 'failed'
    }))).toMatchObject({ color: 'error', text: 'Auto · 失败' })

    expect(selfHealingResultView(state({
      lastAttemptAt: '2026-09-24T10:00:00.000Z',
      lastAttemptTrigger: 'auto',
      lastResult: 'rolled_back'
    }))).toMatchObject({ color: 'warning', text: 'Auto · 已回滚' })
  })

  it('returns no workspace result when there has never been an attempt', () => {
    expect(selfHealingResultView(state({}))).toBeNull()
  })
})
