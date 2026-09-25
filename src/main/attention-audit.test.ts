import { describe, expect, it } from 'vitest'
import type { AttentionPlanStep } from '../shared/profile-attention-plan'
import { runAttentionAudit } from './attention-audit'

function step(patch: Partial<AttentionPlanStep>): AttentionPlanStep {
  return {
    priority: 1,
    profileId: 'profile',
    serialNumber: 1,
    name: 'profile',
    level: 'warning',
    action: 'review_self_healing',
    risk: 'read_only',
    requiresUserConfirmation: false,
    reason: 'test',
    sources: ['self_healing'],
    ...patch
  }
}

describe('attention audit executor', () => {
  it('runs safe steps sequentially and skips confirmation-gated work', async () => {
    const calls: string[] = []
    const plan = [
      step({ priority: 1, profileId: 'process', action: 'inspect_process', sources: ['process'] }),
      step({
        priority: 2,
        profileId: 'confirm',
        action: 'confirm_self_healing',
        risk: 'confirmation_required',
        requiresUserConfirmation: true
      }),
      step({ priority: 3, profileId: 'identity', action: 'run_identity_check', risk: 'policy_gated', sources: ['identity_health'] })
    ]

    const result = await runAttentionAudit(plan, {
      async inspectProcess(id) {
        calls.push('process:' + id)
        return { ok: true }
      },
      async reviewSelfHealing(id) {
        calls.push('healing:' + id)
        return { ok: true }
      },
      async runIdentityCheck(id) {
        calls.push('identity:' + id)
        return { ready: true }
      }
    })

    expect(calls).toEqual(['process:process', 'identity:identity'])
    expect(result).toMatchObject({
      total: 3,
      completed: 2,
      confirmationRequired: 1,
      failed: 0
    })
    expect(result.results[1]).toMatchObject({
      profileId: 'confirm',
      status: 'confirmation_required'
    })
  })

  it('isolates one failed profile and continues later checks', async () => {
    const calls: string[] = []
    const result = await runAttentionAudit([
      step({ priority: 1, profileId: 'first', action: 'review_self_healing' }),
      step({ priority: 2, profileId: 'second', action: 'review_self_healing' })
    ], {
      async inspectProcess() {
        return {}
      },
      async reviewSelfHealing(id) {
        calls.push(id)
        if (id === 'first') throw new Error('status unavailable')
        return { ok: true }
      },
      async runIdentityCheck() {
        return {}
      }
    })

    expect(calls).toEqual(['first', 'second'])
    expect(result).toMatchObject({ completed: 1, failed: 1 })
    expect(result.results[0]).toMatchObject({ status: 'failed', message: 'status unavailable' })
    expect(result.results[1]).toMatchObject({ status: 'completed' })
  })
})
