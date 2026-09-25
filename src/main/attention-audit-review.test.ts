import { describe, expect, it } from 'vitest'
import type { ProfileAttentionItem } from '../shared/profile-attention'
import { reviewAttentionAudit } from './attention-audit-review'

function item(
  profileId: string,
  serialNumber: number,
  issues: ProfileAttentionItem['issues']
): ProfileAttentionItem {
  return {
    profileId,
    serialNumber,
    name: profileId,
    status: 'closed',
    level: issues.some((issue) => issue.level === 'critical') ? 'critical' : 'warning',
    issues
  }
}

describe('post-audit attention review', () => {
  it('separates resolved, remaining and newly detected issue sources', () => {
    const review = reviewAttentionAudit(
      [
        item('alpha', 1, [
          { source: 'identity_health', level: 'warning', reason: 'score low' },
          { source: 'self_healing', level: 'critical', reason: 'manual review' }
        ]),
        item('beta', 2, [
          { source: 'process', level: 'critical', reason: 'error state' }
        ])
      ],
      [
        item('alpha', 1, [
          { source: 'self_healing', level: 'warning', reason: 'cooldown' },
          { source: 'process', level: 'critical', reason: 'new process error' }
        ]),
        item('beta', 2, [
          { source: 'process', level: 'critical', reason: 'error state' }
        ])
      ]
    )

    expect(review).toMatchObject({
      beforeCount: 3,
      afterCount: 3,
      resolvedCount: 1,
      remainingCount: 2,
      newCount: 1
    })
    expect(review.resolved).toEqual([
      expect.objectContaining({
        profileId: 'alpha',
        source: 'identity_health',
        beforeLevel: 'warning'
      })
    ])
    expect(review.remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profileId: 'alpha',
        source: 'self_healing',
        beforeLevel: 'critical',
        afterLevel: 'warning'
      }),
      expect.objectContaining({
        profileId: 'beta',
        source: 'process'
      })
    ]))
    expect(review.newlyDetected).toEqual([
      expect.objectContaining({
        profileId: 'alpha',
        source: 'process',
        afterLevel: 'critical'
      })
    ])
  })

  it('reports a fully cleared queue', () => {
    const review = reviewAttentionAudit(
      [item('done', 1, [{ source: 'identity_health', level: 'warning', reason: 'drift' }])],
      []
    )

    expect(review).toMatchObject({
      beforeCount: 1,
      afterCount: 0,
      resolvedCount: 1,
      remainingCount: 0,
      newCount: 0
    })
  })
})
