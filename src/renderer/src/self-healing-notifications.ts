import type { IdentitySelfHealingSummary } from '../../shared/types'

export type SelfHealingNoticeLevel = 'success' | 'warning' | 'error' | 'info'

export interface SelfHealingNotice {
  profileId: string
  level: SelfHealingNoticeLevel
  title: string
  detail: string
}

function resultNotice(profileId: string, state: IdentitySelfHealingSummary): SelfHealingNotice | null {
  if (!state.lastAttemptAt || state.lastAttemptTrigger !== 'auto') return null
  if (state.lastResult === 'completed') {
    return { profileId, level: 'success', title: 'Auto Self-Healing 修复成功', detail: state.lastMessage ?? state.reason }
  }
  if (state.lastResult === 'rolled_back') {
    return { profileId, level: 'warning', title: 'Auto Self-Healing 已回滚', detail: state.lastMessage ?? state.reason }
  }
  if (state.lastResult === 'failed') {
    return { profileId, level: 'error', title: 'Auto Self-Healing 修复失败', detail: state.lastMessage ?? state.reason }
  }
  if (state.lastResult === 'no_action') {
    return { profileId, level: 'info', title: 'Auto Self-Healing 无需处理', detail: state.lastMessage ?? state.reason }
  }
  return null
}

export function selfHealingStateNotices(
  previous: Record<string, IdentitySelfHealingSummary>,
  current: Record<string, IdentitySelfHealingSummary>
): SelfHealingNotice[] {
  const notices: SelfHealingNotice[] = []

  for (const [profileId, next] of Object.entries(current)) {
    const before = previous[profileId]
    if (!before) continue

    if (next.lastAttemptAt && next.lastAttemptAt !== before.lastAttemptAt) {
      const notice = resultNotice(profileId, next)
      if (notice) notices.push(notice)
      continue
    }

    if (next.decision !== before.decision) {
      if (next.decision === 'blocked') {
        notices.push({
          profileId,
          level: 'error',
          title: 'Self-Healing 已触发保护阻止',
          detail: next.reason
        })
      } else if (next.decision === 'cooldown') {
        notices.push({
          profileId,
          level: 'warning',
          title: 'Self-Healing 已进入冷却',
          detail: next.reason
        })
      }
    }
  }

  return notices
}
