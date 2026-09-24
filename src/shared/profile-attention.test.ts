import { describe, expect, it } from 'vitest'
import type { BrowserProfileView, IdentityProfileHealthSummary, IdentitySelfHealingSummary } from './types'
import { profileAttentionItem, profileAttentionQueue } from './profile-attention'

function profile(id: string, serialNumber: number, status: BrowserProfileView['status'] = 'closed'): BrowserProfileView {
  return {
    id,
    serialNumber,
    name: id,
    note: '',
    group: '',
    tags: [],
    extensionIds: [],
    color: '#000000',
    startUrls: [],
    kernelVersion: '',
    window: { mode: 'auto', x: 0, y: 0, width: 1280, height: 720 },
    favorite: false,
    proxy: { protocol: 'direct', host: '', username: '', password: '', passwordStored: false },
    fingerprint: {
      seed: 1,
      hardwareProfileId: 'windows-11-rtx4060',
      platform: 'windows',
      platformVersion: '10.0.0',
      brand: 'Chrome',
      brandVersion: '140',
      hardwareConcurrency: 8,
      language: 'en-US',
      acceptLanguages: 'en-US,en',
      timezone: 'America/Los_Angeles',
      webrtcPolicy: 'proxy_only',
      networkIdentityMode: 'manual',
      proxyExitPolicy: 'warn',
      screenWidth: 1920,
      screenHeight: 1080,
      disabledSpoofing: []
    },
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    status
  }
}

function healing(patch: Partial<IdentitySelfHealingSummary>): IdentitySelfHealingSummary {
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

describe('profile attention queue', () => {
  it('combines process, identity and self-healing issues into one item', () => {
    const item = profileAttentionItem(
      { ...profile('a', 1, 'error'), lastError: 'browser exited' },
      { state: 'attention', score: 72 } satisfies IdentityProfileHealthSummary,
      healing({ pending: true, pendingStrategyKind: 'manual_review', pendingReason: 'review identity' })
    )

    expect(item).toMatchObject({
      profileId: 'a',
      level: 'critical',
      issues: [
        { source: 'process', level: 'critical' },
        { source: 'identity_health', level: 'warning' },
        { source: 'self_healing', level: 'critical' }
      ]
    })
  })

  it('ignores healthy profiles and low-risk auto pending work', () => {
    expect(profileAttentionItem(
      profile('healthy', 1),
      { state: 'healthy', score: 100 },
      healing({
        mode: 'auto',
        decision: 'auto_execute',
        pending: true,
        pendingStrategyKind: 'repair_configuration'
      })
    )).toBeNull()
  })

  it('sorts critical profiles before warnings and keeps stable serial order', () => {
    const queue = profileAttentionQueue(
      [profile('warning-b', 3), profile('critical', 9), profile('warning-a', 2)],
      {
        'warning-a': { state: 'attention', score: 80 },
        'warning-b': { state: 'attention', score: 75 },
        critical: { state: 'critical', score: 40 }
      },
      {}
    )
    expect(queue.map((item) => item.profileId)).toEqual(['critical', 'warning-a', 'warning-b'])
  })
})
