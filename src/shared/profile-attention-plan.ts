import type {
  BrowserProfileView,
  IdentityProfileHealthSummary,
  IdentitySelfHealingSummary
} from './types'
import { profileAttentionQueue, type ProfileAttentionItem } from './profile-attention'

export type AttentionPlanAction =
  | 'inspect_process'
  | 'run_identity_check'
  | 'review_self_healing'
  | 'confirm_self_healing'

export type AttentionPlanRisk = 'read_only' | 'policy_gated' | 'confirmation_required'

export interface AttentionPlanStep {
  priority: number
  profileId: string
  serialNumber: number
  name: string
  level: ProfileAttentionItem['level']
  action: AttentionPlanAction
  risk: AttentionPlanRisk
  recommendedTool?: string
  requiresUserConfirmation: boolean
  reason: string
  sources: ProfileAttentionItem['issues'][number]['source'][]
}

function planStep(
  item: ProfileAttentionItem,
  selfHealing?: IdentitySelfHealingSummary
): Omit<AttentionPlanStep, 'priority'> {
  const sources = [...new Set(item.issues.map((issue) => issue.source))]
  const processIssue = item.issues.find((issue) => issue.source === 'process')
  const healingIssue = item.issues.find((issue) => issue.source === 'self_healing')
  const healthIssue = item.issues.find((issue) => issue.source === 'identity_health')

  if (processIssue) {
    return {
      profileId: item.profileId,
      serialNumber: item.serialNumber,
      name: item.name,
      level: item.level,
      action: 'inspect_process',
      risk: 'read_only',
      recommendedTool: 'profile_status',
      requiresUserConfirmation: false,
      reason: processIssue.reason,
      sources
    }
  }

  if (healingIssue) {
    const requiresConfirmation = selfHealing?.pending === true && (
      selfHealing.pendingStrategyKind === 'manual_review'
      || selfHealing.pendingStrategyKind === 'regenerate_identity'
      || selfHealing.pendingStrategyKind === 'switch_proxy'
      || selfHealing.decision === 'suggest'
    )
    if (requiresConfirmation) {
      return {
        profileId: item.profileId,
        serialNumber: item.serialNumber,
        name: item.name,
        level: item.level,
        action: 'confirm_self_healing',
        risk: 'confirmation_required',
        recommendedTool: 'profile_self_healing_status',
        requiresUserConfirmation: true,
        reason: healingIssue.reason,
        sources
      }
    }

    return {
      profileId: item.profileId,
      serialNumber: item.serialNumber,
      name: item.name,
      level: item.level,
      action: 'review_self_healing',
      risk: 'read_only',
      recommendedTool: 'profile_self_healing_status',
      requiresUserConfirmation: false,
      reason: healingIssue.reason,
      sources
    }
  }

  return {
    profileId: item.profileId,
    serialNumber: item.serialNumber,
    name: item.name,
    level: item.level,
    action: 'run_identity_check',
    risk: 'policy_gated',
    recommendedTool: 'profile_diagnose_fingerprint_runtime',
    requiresUserConfirmation: false,
    reason: healthIssue?.reason ?? 'Identity Health 需要复核',
    sources
  }
}

export function profileAttentionPlan(
  profiles: BrowserProfileView[],
  identityHealth: Record<string, IdentityProfileHealthSummary>,
  selfHealing: Record<string, IdentitySelfHealingSummary>
): AttentionPlanStep[] {
  return profileAttentionQueue(profiles, identityHealth, selfHealing)
    .map((item, index) => ({
      priority: index + 1,
      ...planStep(item, selfHealing[item.profileId])
    }))
}
