import type { BrowserProfile } from '../shared/types'
import type { IdentityProfileHealthSummary } from '../shared/identity-profile-health'
import type { AttentionAuditHistoryRecord } from './attention-audit-history'
import type { AttentionPlanHistoryContext, AttentionPlanHistorySignal } from '../shared/profile-attention-plan'

export type AttentionInsightSignal = AttentionPlanHistorySignal

export interface AttentionInsightItem {
  profileId: string
  serialNumber: number
  name: string
  level: 'warning' | 'critical'
  signals: AttentionInsightSignal[]
  appearances: number
  failures: number
  confirmationRequired: number
  latestSeenAt?: string
  identityScore?: number
  identityDelta?: number
  reason: string
}

const AUDIT_WINDOW = 10

type InsightProfile = Pick<BrowserProfile, 'id' | 'serialNumber' | 'name'>

export function attentionInsights(
  profiles: InsightProfile[],
  history: AttentionAuditHistoryRecord[],
  identityHealth: Record<string, IdentityProfileHealthSummary>
): AttentionInsightItem[] {
  const recent = history.slice(0, AUDIT_WINDOW)
  const items: AttentionInsightItem[] = []

  for (const profile of profiles) {
    const auditSteps = recent.flatMap((record) =>
      record.results
        .filter((step) => step.profileId === profile.id)
        .map((step) => ({ ...step, auditCompletedAt: record.completedAt }))
    )
    const appearances = auditSteps.length
    const failures = auditSteps.filter((step) => step.status === 'failed').length
    const confirmationRequired = auditSteps.filter((step) => step.status === 'confirmation_required').length
    const health = identityHealth[profile.id]
    const degrading = health?.trend?.direction === 'degrading' && (health.trend.sampleCount ?? 0) >= 2

    const signals: AttentionInsightSignal[] = []
    if (failures >= 2) signals.push('repeated_failure')
    if (confirmationRequired >= 3) signals.push('repeated_confirmation')
    if (appearances >= 3) signals.push('repeated_attention')
    if (degrading) signals.push('identity_degrading')
    if (!signals.length) continue

    const critical = failures >= 2
      || (degrading && health?.state === 'critical')
      || confirmationRequired >= 5

    const latestSeenAt = auditSteps
      .map((step) => step.completedAt ?? step.startedAt ?? step.auditCompletedAt)
      .find((value): value is string => typeof value === 'string')

    const reasons: string[] = []
    if (failures >= 2) reasons.push(`最近 ${AUDIT_WINDOW} 次巡检中失败 ${failures} 次`)
    if (confirmationRequired >= 3) reasons.push(`最近 ${AUDIT_WINDOW} 次巡检中有 ${confirmationRequired} 次需要人工确认`)
    if (appearances >= 3) reasons.push(`最近 ${AUDIT_WINDOW} 次巡检中出现 ${appearances} 次`)
    if (degrading) {
      reasons.push(`Identity Health 持续下降${health?.trend?.delta === undefined ? '' : `（最近变化 ${health.trend.delta}）`}`)
    }

    items.push({
      profileId: profile.id,
      serialNumber: profile.serialNumber,
      name: profile.name,
      level: critical ? 'critical' : 'warning',
      signals,
      appearances,
      failures,
      confirmationRequired,
      latestSeenAt,
      identityScore: health?.score,
      identityDelta: health?.trend?.delta,
      reason: reasons.join('；')
    })
  }

  return items.sort((first, second) => {
    if (first.level !== second.level) return first.level === 'critical' ? -1 : 1
    if (first.failures !== second.failures) return second.failures - first.failures
    if (first.confirmationRequired !== second.confirmationRequired) {
      return second.confirmationRequired - first.confirmationRequired
    }
    if (first.appearances !== second.appearances) return second.appearances - first.appearances
    return first.serialNumber - second.serialNumber
  })
}


export function attentionInsightContext(
  items: AttentionInsightItem[]
): Record<string, AttentionPlanHistoryContext> {
  return Object.fromEntries(items.map((item) => [item.profileId, {
    level: item.level,
    signals: item.signals,
    appearances: item.appearances,
    failures: item.failures,
    confirmationRequired: item.confirmationRequired,
    reason: item.reason
  }]))
}
