import type { ProxyPoolEntry } from '../shared/types'

export const MAX_PROXY_POOL_CHECK_AGE_MS = 24 * 60 * 60 * 1000

function healthPriority(entry: ProxyPoolEntry): number {
  return entry.health === 'healthy' ? 0 : 1
}

export function selectBestProxyPoolEntry(
  entries: readonly ProxyPoolEntry[],
  nowMs = Date.now()
): ProxyPoolEntry | undefined {
  return [...entries]
    .filter((entry) => {
      if (entry.health !== 'healthy' && entry.health !== 'degraded') return false
      if (!entry.check?.ok) return false
      const checkedAt = Date.parse(entry.check.checkedAt)
      if (!Number.isFinite(checkedAt)) return false
      const age = nowMs - checkedAt
      return age >= 0 && age <= MAX_PROXY_POOL_CHECK_AGE_MS
    })
    .sort((a, b) => {
      const health = healthPriority(a) - healthPriority(b)
      if (health) return health
      const score = b.score - a.score
      if (score) return score
      const latency = (a.check?.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.check?.latencyMs ?? Number.MAX_SAFE_INTEGER)
      if (latency) return latency
      return Date.parse(b.check!.checkedAt) - Date.parse(a.check!.checkedAt)
    })[0]
}
