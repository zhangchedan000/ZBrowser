import type { BrowserProfileView, IdentitySelfHealingSummary } from '../../shared/types'

export interface SelfHealingAttentionItem {
  profile: BrowserProfileView
  state: IdentitySelfHealingSummary
  level: 'warning' | 'critical'
  reason: string
}

export function classifySelfHealingAttention(
  profile: BrowserProfileView,
  state: IdentitySelfHealingSummary
): SelfHealingAttentionItem | null {
  if (state.decision === 'blocked') {
    return { profile, state, level: 'critical', reason: state.reason }
  }
  if (state.decision === 'cooldown') {
    return { profile, state, level: 'warning', reason: state.reason }
  }
  if (!state.pending) return null

  if (state.pendingStrategyKind === 'manual_review') {
    return {
      profile,
      state,
      level: 'critical',
      reason: state.pendingReason ?? state.reason
    }
  }

  if (
    state.pendingStrategyKind === 'regenerate_identity'
    || state.pendingStrategyKind === 'switch_proxy'
    || state.decision === 'suggest'
  ) {
    return {
      profile,
      state,
      level: state.pendingStrategyKind === 'regenerate_identity' ? 'critical' : 'warning',
      reason: state.pendingReason ?? state.reason
    }
  }

  return null
}

export type SelfHealingAttentionAction = 'execute' | 'diagnose' | 'review'

export function selfHealingAttentionAction(
  profile: BrowserProfileView,
  state?: IdentitySelfHealingSummary
): SelfHealingAttentionAction | null {
  if (!state || !classifySelfHealingAttention(profile, state)) return null
  if (state.decision === 'blocked' || state.decision === 'cooldown') return 'review'
  if (state.pendingStrategyKind === 'manual_review') return 'diagnose'
  if (profile.status !== 'closed' && profile.status !== 'error') return 'review'
  if (state.pending && state.pendingStrategyKind) return 'execute'
  return 'review'
}

export function profileHasSelfHealingAttention(
  profile: BrowserProfileView,
  state?: IdentitySelfHealingSummary
): boolean {
  return selfHealingAttentionAction(profile, state) !== null
}

export function selfHealingAttentionItems(
  profiles: BrowserProfileView[],
  states: Record<string, IdentitySelfHealingSummary>,
  fallback: (profile: BrowserProfileView) => IdentitySelfHealingSummary
): SelfHealingAttentionItem[] {
  return profiles
    .map((profile) => classifySelfHealingAttention(profile, states[profile.id] ?? fallback(profile)))
    .filter((item): item is SelfHealingAttentionItem => item !== null)
    .sort((first, second) => {
      if (first.level !== second.level) return first.level === 'critical' ? -1 : 1
      const firstTime = first.state.pendingDetectedAt ?? first.state.lastAttemptAt ?? ''
      const secondTime = second.state.pendingDetectedAt ?? second.state.lastAttemptAt ?? ''
      return secondTime.localeCompare(firstTime)
    })
}
