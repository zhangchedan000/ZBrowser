import type { IdentitySelfHealingSummary } from '../../shared/types'

export interface SelfHealingResultView {
  color: 'success' | 'error' | 'warning' | 'default' | 'processing'
  text: string
  detail: string
}

export function selfHealingResultView(state?: IdentitySelfHealingSummary): SelfHealingResultView | null {
  if (!state?.lastAttemptAt) return null

  const source = state.lastAttemptTrigger === 'user' ? '人工' : 'Auto'
  const result = state.lastResult
  const view = result === 'completed'
    ? { color: 'success' as const, text: '成功' }
    : result === 'rolled_back'
      ? { color: 'warning' as const, text: '已回滚' }
      : result === 'failed'
        ? { color: 'error' as const, text: '失败' }
        : result === 'no_action'
          ? { color: 'default' as const, text: '无操作' }
          : { color: 'processing' as const, text: '执行中' }

  return {
    color: view.color,
    text: `${source} · ${view.text}`,
    detail: [
      `${source}执行`,
      view.text,
      state.lastStrategyKind ? `策略 ${state.lastStrategyKind}` : undefined,
      new Date(state.lastAttemptAt).toLocaleString(),
      state.lastMessage
    ].filter(Boolean).join(' · ')
  }
}
