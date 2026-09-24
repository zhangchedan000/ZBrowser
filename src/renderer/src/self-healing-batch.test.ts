import { describe, expect, it } from 'vitest'
import type { BrowserProfileView } from '../../shared/types'
import { runSelfHealingBatchChecks, selfHealingBatchCandidates } from './self-healing-batch'

function profile(id: string, status: BrowserProfileView['status']): BrowserProfileView {
  return {
    id,
    name: id,
    status
  } as BrowserProfileView
}

describe('self-healing batch checks', () => {
  it('only selects closed or error environments', () => {
    const candidates = selfHealingBatchCandidates([
      profile('closed', 'closed'),
      profile('error', 'error'),
      profile('running', 'running'),
      profile('starting', 'starting')
    ])
    expect(candidates.map((item) => item.id)).toEqual(['closed', 'error'])
  })

  it('runs eligible environments sequentially and keeps failures isolated', async () => {
    const order: string[] = []
    const result = await runSelfHealingBatchChecks(
      [profile('a', 'closed'), profile('skip', 'running'), profile('b', 'error')],
      async (item) => {
        order.push('diagnose:' + item.id)
        if (item.id === 'b') throw new Error('diagnose failed')
        return { profileId: item.id, checkedAt: new Date().toISOString(), ready: true, checks: [] }
      },
      async (item) => {
        order.push('health:' + item.id)
        return { state: 'healthy' } as Awaited<ReturnType<Parameters<typeof runSelfHealingBatchChecks>[2]>>
      }
    )

    expect(order).toEqual(['diagnose:a', 'health:a', 'diagnose:b'])
    expect(result.candidates).toBe(2)
    expect(result.successes).toHaveLength(1)
    expect(result.failures).toEqual([
      expect.objectContaining({ profileId: 'b', message: 'diagnose failed' })
    ])
  })
})
