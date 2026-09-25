import { describe, expect, it } from 'vitest'
import type { BrowserProfileView, IdentityProfileHealthSummary, IdentitySelfHealingSummary } from './types'
import { profileAttentionPlan } from './profile-attention-plan'

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

describe('profile attention plan', () => {
  it('prioritizes process inspection ahead of lower-priority checks', () => {
    const health: Record<string, IdentityProfileHealthSummary> = {
      process: { state: 'critical', score: 30 },
      identity: { state: 'attention', score: 70 }
    }
    const plan = profileAttentionPlan(
      [profile('identity', 1), profile('process', 9, 'error')],
      health,
      {}
    )

    expect(plan[0]).toMatchObject({
      priority: 1,
      profileId: 'process',
      action: 'inspect_process',
      risk: 'read_only',
      recommendedTool: 'profile_status',
      requiresUserConfirmation: false
    })
    expect(plan[1]).toMatchObject({
      priority: 2,
      profileId: 'identity',
      action: 'run_identity_check',
      risk: 'policy_gated',
      recommendedTool: 'profile_diagnose_fingerprint_runtime'
    })
  })

  it('marks confirmation-gated self-healing as requiring the user', () => {
    const plan = profileAttentionPlan(
      [profile('healing', 1)],
      {},
      {
        healing: healing({
          pending: true,
          pendingStrategyKind: 'regenerate_identity',
          pendingReason: 'identity regeneration required'
        })
      }
    )

    expect(plan[0]).toMatchObject({
      action: 'confirm_self_healing',
      risk: 'confirmation_required',
      recommendedTool: 'profile_self_healing_status',
      strategyKind: 'regenerate_identity',
      requiresUserConfirmation: true
    })
  })

  it('promotes recurring critical history ahead of one-off attention', () => {
    const plan = profileAttentionPlan(
      [profile('one-off', 1), profile('recurring', 9)],
      {
        'one-off': { state: 'attention', score: 82 },
        recurring: { state: 'attention', score: 61 }
      },
      {},
      {
        recurring: {
          level: 'critical',
          signals: ['repeated_failure', 'identity_degrading'],
          appearances: 5,
          failures: 2,
          confirmationRequired: 0,
          reason: '最近多次失败并持续下降'
        }
      }
    )

    expect(plan.map((step) => step.profileId)).toEqual(['recurring', 'one-off'])
    expect(plan[0]).toMatchObject({
      priority: 1,
      profileId: 'recurring',
      historyContext: {
        level: 'critical',
        failures: 2,
        signals: expect.arrayContaining(['repeated_failure', 'identity_degrading'])
      }
    })
  })

  it('uses read-only review while self-healing is blocked', () => {
    const plan = profileAttentionPlan(
      [profile('blocked', 1)],
      {},
      {
        blocked: healing({
          decision: 'blocked',
          reason: 'loop guard active'
        })
      }
    )

    expect(plan[0]).toMatchObject({
      action: 'review_self_healing',
      risk: 'read_only',
      recommendedTool: 'profile_self_healing_status',
      requiresUserConfirmation: false
    })
  })
})
