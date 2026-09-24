import type {
  BrowserProfileView,
  IdentityProfileHealthSummary,
  IdentitySelfHealingSummary,
  ProfileStatus
} from './types'

export type ProfileAttentionLevel = 'warning' | 'critical'
export type ProfileAttentionSource = 'process' | 'identity_health' | 'self_healing'

export interface ProfileAttentionIssue {
  source: ProfileAttentionSource
  level: ProfileAttentionLevel
  reason: string
}

export interface ProfileAttentionItem {
  profileId: string
  serialNumber: number
  name: string
  status: ProfileStatus
  level: ProfileAttentionLevel
  issues: ProfileAttentionIssue[]
}

type AttentionProfile = Pick<BrowserProfileView, 'id' | 'serialNumber' | 'name' | 'status' | 'lastError'>

function selfHealingIssue(state?: IdentitySelfHealingSummary): ProfileAttentionIssue | null {
  if (!state) return null
  if (state.decision === 'blocked') {
    return { source: 'self_healing', level: 'critical', reason: state.reason }
  }
  if (state.decision === 'cooldown') {
    return { source: 'self_healing', level: 'warning', reason: state.reason }
  }
  if (!state.pending) return null

  const reason = state.pendingReason ?? state.reason
  if (state.pendingStrategyKind === 'manual_review' || state.pendingStrategyKind === 'regenerate_identity') {
    return { source: 'self_healing', level: 'critical', reason }
  }
  if (state.pendingStrategyKind === 'switch_proxy' || state.decision === 'suggest') {
    return { source: 'self_healing', level: 'warning', reason }
  }
  return null
}

export function profileAttentionItem(
  profile: AttentionProfile,
  identityHealth?: IdentityProfileHealthSummary,
  selfHealing?: IdentitySelfHealingSummary
): ProfileAttentionItem | null {
  const issues: ProfileAttentionIssue[] = []

  if (profile.status === 'orphaned' || profile.status === 'error') {
    issues.push({
      source: 'process',
      level: 'critical',
      reason: profile.lastError ?? (profile.status === 'orphaned' ? '检测到遗留浏览器进程' : '环境处于异常状态')
    })
  }

  if (identityHealth?.state === 'critical') {
    issues.push({
      source: 'identity_health',
      level: 'critical',
      reason: `Identity Health 为 Critical${identityHealth.score === undefined ? '' : `（${identityHealth.score}）`}`
    })
  } else if (identityHealth?.state === 'attention') {
    issues.push({
      source: 'identity_health',
      level: 'warning',
      reason: `Identity Health 需要关注${identityHealth.score === undefined ? '' : `（${identityHealth.score}）`}`
    })
  }

  const healingIssue = selfHealingIssue(selfHealing)
  if (healingIssue) issues.push(healingIssue)

  if (!issues.length) return null
  return {
    profileId: profile.id,
    serialNumber: profile.serialNumber,
    name: profile.name,
    status: profile.status,
    level: issues.some((issue) => issue.level === 'critical') ? 'critical' : 'warning',
    issues
  }
}

export function profileAttentionQueue(
  profiles: AttentionProfile[],
  identityHealth: Record<string, IdentityProfileHealthSummary>,
  selfHealing: Record<string, IdentitySelfHealingSummary>
): ProfileAttentionItem[] {
  return profiles
    .map((profile) => profileAttentionItem(profile, identityHealth[profile.id], selfHealing[profile.id]))
    .filter((item): item is ProfileAttentionItem => item !== null)
    .sort((first, second) => {
      if (first.level !== second.level) return first.level === 'critical' ? -1 : 1
      return first.serialNumber - second.serialNumber
    })
}
