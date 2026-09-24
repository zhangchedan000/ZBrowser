import { describe, expect, it } from 'vitest'
import type { ProxyPoolEntry, ProxyPoolHealth } from '../shared/types'
import { MAX_PROXY_POOL_CHECK_AGE_MS, selectBestProxyPoolEntry, selectBestProxyPoolEntryForCountry } from './proxy-pool-selection'

function entry(
  id: string,
  health: ProxyPoolHealth,
  score: number,
  checkedAt: string,
  latencyMs = 100,
  ok = true
): ProxyPoolEntry {
  return {
    id,
    name: id,
    tags: [],
    proxy: {
      protocol: 'http',
      host: id + '.example.com',
      port: 8080,
      username: '',
      password: '',
      passwordStored: false
    },
    createdAt: checkedAt,
    updatedAt: checkedAt,
    check: { ok, ip: '203.0.113.10', latencyMs, checkedAt, countryCode: id.startsWith('de') ? 'DE' : 'US' },
    health,
    score,
    stats: {
      checks: 1,
      successes: ok ? 1 : 0,
      consecutiveFailures: ok ? 0 : 1,
      successRate: ok ? 1 : 0,
      averageLatencyMs: ok ? latencyMs : undefined,
      lastCheckedAt: checkedAt,
      lastSuccessAt: ok ? checkedAt : undefined,
      lastFailureAt: ok ? undefined : checkedAt
    },
    assignedProfileIds: []
  }
}

describe('selectBestProxyPoolEntry', () => {
  const now = Date.parse('2026-09-23T00:00:00.000Z')

  it('prefers a healthy proxy over a higher-scoring degraded proxy', () => {
    const healthy = entry('healthy', 'healthy', 72, new Date(now - 60_000).toISOString(), 180)
    const degraded = entry('degraded', 'degraded', 99, new Date(now - 30_000).toISOString(), 80)
    expect(selectBestProxyPoolEntry([degraded, healthy], now)?.id).toBe('healthy')
  })

  it('rejects stale, future, failed and unchecked candidates', () => {
    const stale = entry('stale', 'healthy', 100, new Date(now - MAX_PROXY_POOL_CHECK_AGE_MS - 1).toISOString())
    const future = entry('future', 'healthy', 100, new Date(now + 1).toISOString())
    const failed = entry('failed', 'failed', 100, new Date(now - 1_000).toISOString(), 20, false)
    const unchecked = entry('unchecked', 'unchecked', 100, new Date(now - 1_000).toISOString())
    expect(selectBestProxyPoolEntry([stale, future, failed, unchecked], now)).toBeUndefined()
  })

  it('selects only healthy recent proxies matching the requested country', () => {
    const us = entry('us-fast', 'healthy', 95, new Date(now - 1_000).toISOString(), 60)
    const deFast = entry('de-fast', 'healthy', 99, new Date(now - 500).toISOString(), 30)
    const deSlow = entry('de-slow', 'healthy', 80, new Date(now - 800).toISOString(), 150)

    expect(selectBestProxyPoolEntryForCountry([us, deSlow, deFast], 'de', now)?.id).toBe('de-fast')
    expect(selectBestProxyPoolEntryForCountry([us], 'DE', now)).toBeUndefined()
  })

  it('uses score, current latency and recency as deterministic tie-breakers', () => {
    const lowerScore = entry('lower-score', 'healthy', 80, new Date(now - 10_000).toISOString(), 20)
    const slower = entry('slower', 'healthy', 90, new Date(now - 5_000).toISOString(), 200)
    const fasterOlder = entry('faster-older', 'healthy', 90, new Date(now - 20_000).toISOString(), 90)
    const fasterNewer = entry('faster-newer', 'healthy', 90, new Date(now - 2_000).toISOString(), 90)

    expect(selectBestProxyPoolEntry([lowerScore, slower, fasterOlder, fasterNewer], now)?.id).toBe('faster-newer')
  })
})
