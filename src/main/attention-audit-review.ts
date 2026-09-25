import type { ProfileAttentionItem, ProfileAttentionIssue, ProfileAttentionSource } from '../shared/profile-attention'

export interface AttentionAuditReviewIssue {
  profileId: string
  serialNumber: number
  name: string
  source: ProfileAttentionSource
  beforeLevel?: ProfileAttentionIssue['level']
  afterLevel?: ProfileAttentionIssue['level']
  beforeReason?: string
  afterReason?: string
}

export interface AttentionAuditReview {
  beforeCount: number
  afterCount: number
  resolvedCount: number
  remainingCount: number
  newCount: number
  resolved: AttentionAuditReviewIssue[]
  remaining: AttentionAuditReviewIssue[]
  newlyDetected: AttentionAuditReviewIssue[]
}

interface FlatIssue {
  profileId: string
  serialNumber: number
  name: string
  issue: ProfileAttentionIssue
}

function issueKey(profileId: string, source: ProfileAttentionSource): string {
  return profileId + ':' + source
}

function flatten(items: ProfileAttentionItem[]): FlatIssue[] {
  return items.flatMap((item) => item.issues.map((issue) => ({
    profileId: item.profileId,
    serialNumber: item.serialNumber,
    name: item.name,
    issue
  })))
}

export function reviewAttentionAudit(
  before: ProfileAttentionItem[],
  after: ProfileAttentionItem[]
): AttentionAuditReview {
  const beforeIssues = flatten(before)
  const afterIssues = flatten(after)
  const beforeByKey = new Map(beforeIssues.map((entry) => [issueKey(entry.profileId, entry.issue.source), entry]))
  const afterByKey = new Map(afterIssues.map((entry) => [issueKey(entry.profileId, entry.issue.source), entry]))

  const resolved: AttentionAuditReviewIssue[] = []
  const remaining: AttentionAuditReviewIssue[] = []
  const newlyDetected: AttentionAuditReviewIssue[] = []

  for (const entry of beforeIssues) {
    const current = afterByKey.get(issueKey(entry.profileId, entry.issue.source))
    if (!current) {
      resolved.push({
        profileId: entry.profileId,
        serialNumber: entry.serialNumber,
        name: entry.name,
        source: entry.issue.source,
        beforeLevel: entry.issue.level,
        beforeReason: entry.issue.reason
      })
      continue
    }
    remaining.push({
      profileId: entry.profileId,
      serialNumber: entry.serialNumber,
      name: entry.name,
      source: entry.issue.source,
      beforeLevel: entry.issue.level,
      afterLevel: current.issue.level,
      beforeReason: entry.issue.reason,
      afterReason: current.issue.reason
    })
  }

  for (const entry of afterIssues) {
    if (beforeByKey.has(issueKey(entry.profileId, entry.issue.source))) continue
    newlyDetected.push({
      profileId: entry.profileId,
      serialNumber: entry.serialNumber,
      name: entry.name,
      source: entry.issue.source,
      afterLevel: entry.issue.level,
      afterReason: entry.issue.reason
    })
  }

  return {
    beforeCount: beforeIssues.length,
    afterCount: afterIssues.length,
    resolvedCount: resolved.length,
    remainingCount: remaining.length,
    newCount: newlyDetected.length,
    resolved,
    remaining,
    newlyDetected
  }
}
