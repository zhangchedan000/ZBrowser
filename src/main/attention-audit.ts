import type { AttentionPlanStep } from '../shared/profile-attention-plan'

export type AttentionAuditResultStatus = 'completed' | 'confirmation_required' | 'failed'

export interface AttentionAuditStepResult {
  priority: number
  profileId: string
  action: AttentionPlanStep['action']
  risk: AttentionPlanStep['risk']
  status: AttentionAuditResultStatus
  startedAt?: string
  completedAt?: string
  message: string
  result?: unknown
}

export interface AttentionAuditSummary {
  startedAt: string
  completedAt: string
  total: number
  completed: number
  confirmationRequired: number
  failed: number
  results: AttentionAuditStepResult[]
}

export interface AttentionAuditActions {
  inspectProcess(profileId: string): Promise<unknown>
  reviewSelfHealing(profileId: string): Promise<unknown>
  runIdentityCheck(profileId: string): Promise<unknown>
}

export async function runAttentionAudit(
  plan: AttentionPlanStep[],
  actions: AttentionAuditActions
): Promise<AttentionAuditSummary> {
  const auditStartedAt = new Date().toISOString()
  const results: AttentionAuditStepResult[] = []

  for (const step of plan) {
    if (step.requiresUserConfirmation) {
      results.push({
        priority: step.priority,
        profileId: step.profileId,
        action: step.action,
        risk: step.risk,
        status: 'confirmation_required',
        message: step.reason
      })
      continue
    }

    const startedAt = new Date().toISOString()
    try {
      const result = step.action === 'inspect_process'
        ? await actions.inspectProcess(step.profileId)
        : step.action === 'run_identity_check'
          ? await actions.runIdentityCheck(step.profileId)
          : await actions.reviewSelfHealing(step.profileId)
      results.push({
        priority: step.priority,
        profileId: step.profileId,
        action: step.action,
        risk: step.risk,
        status: 'completed',
        startedAt,
        completedAt: new Date().toISOString(),
        message: step.reason,
        result
      })
    } catch (error) {
      results.push({
        priority: step.priority,
        profileId: step.profileId,
        action: step.action,
        risk: step.risk,
        status: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return {
    startedAt: auditStartedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    completed: results.filter((item) => item.status === 'completed').length,
    confirmationRequired: results.filter((item) => item.status === 'confirmation_required').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results
  }
}
