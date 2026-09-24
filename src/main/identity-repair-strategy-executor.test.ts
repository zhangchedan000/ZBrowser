import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type {
  FingerprintRepairPlan,
  FingerprintRuntimeDiagnosticReport,
  ProxyCheckSummary,
  ProxyConfig,
  ProxyPoolEntry
} from '../shared/types'
import { ProfileStore } from './profile-store'
import { IdentityRepairStrategyExecutor } from './identity-repair-strategy-executor'

const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function check(countryCode = 'US'): ProxyCheckSummary {
  return {
    ok: true,
    ip: countryCode === 'US' ? '203.0.113.10' : '198.51.100.20',
    latencyMs: 15,
    country: countryCode === 'US' ? 'United States' : 'Germany',
    countryCode,
    latitude: countryCode === 'US' ? 40.7128 : 52.52,
    longitude: countryCode === 'US' ? -74.006 : 13.405,
    timezone: countryCode === 'US' ? 'America/New_York' : 'Europe/Berlin',
    geoConfidence: 'consensus',
    checkedAt: new Date().toISOString()
  }
}

function entry(countryCode = 'US'): ProxyPoolEntry {
  const now = new Date().toISOString()
  return {
    id: 'proxy-us',
    name: 'US Proxy',
    tags: [],
    proxy: { protocol: 'http', host: '127.0.0.1', port: 8080, username: '', passwordStored: false },
    createdAt: now,
    updatedAt: now,
    check: check(countryCode),
    health: 'healthy',
    score: 98,
    stats: {
      checks: 1,
      successes: 1,
      consecutiveFailures: 0,
      successRate: 1,
      averageLatencyMs: 15,
      lastCheckedAt: now,
      lastSuccessAt: now
    },
    assignedProfileIds: []
  }
}

function report(kind: 'switch_proxy' | 'none', ready: boolean, countryCode: string): FingerprintRuntimeDiagnosticReport {
  return {
    profileId: 'profile-1',
    checkedAt: new Date().toISOString(),
    ready,
    identityIntentConsistency: {
      status: ready ? 'aligned' : 'mismatch',
      targetCountryCode: 'US',
      proxyCountryCode: countryCode,
      runtimeCountryCode: countryCode,
      warnings: ready ? [] : ['country mismatch']
    },
    identityRepairStrategy: kind === 'switch_proxy'
      ? {
          kind: 'switch_proxy',
          reason: 'switch',
          affectedSections: ['network'],
          requiresUserConfirmation: true,
          automaticActionAvailable: true,
          targetCountryCode: 'US',
          candidateProxy: { id: 'proxy-us', name: 'US Proxy', countryCode: 'US', score: 98 }
        }
      : {
          kind: 'none',
          reason: 'healthy',
          affectedSections: [],
          requiresUserConfirmation: false,
          automaticActionAvailable: false,
          targetCountryCode: 'US'
        },
    checks: []
  }
}

async function harness(verifierReports: FingerprintRuntimeDiagnosticReport[]) {
  const vault = await mkdtemp(join(tmpdir(), 'zbrowser-strategy-'))
  paths.push(vault)
  const profiles = new ProfileStore(vault)
  await profiles.initialize()
  const draft = defaultProfileDraft()
  draft.identityIntent = { schemaVersion: 1, targetCountryCode: 'US', strategy: 'ai_assisted' }
  const profile = await profiles.create(draft)

  const candidate = entry('US')
  const pool = {
    async test() { return candidate },
    check() { return candidate.check },
    proxyConfig(): ProxyConfig {
      return { protocol: 'http', host: '127.0.0.1', port: 8080, username: '', password: '' }
    }
  }
  if (!verifierReports.length) throw new Error('test verifier requires at least one report')
  let index = 0
  const verifier = {
    async diagnoseFingerprintRuntime() {
      return verifierReports[Math.min(index++, verifierReports.length - 1)]!
    }
  }
  const repair = {
    async plan(): Promise<FingerprintRepairPlan> {
      throw new Error('fingerprint repair should not run')
    },
    async execute() {
      throw new Error('fingerprint repair should not run')
    }
  }

  return {
    profiles,
    profile,
    executor: new IdentityRepairStrategyExecutor(profiles, verifier, pool, repair)
  }
}

describe('IdentityRepairStrategyExecutor', () => {
  it('switches to the recommended target-country proxy and verifies the runtime', async () => {
    const { executor, profiles, profile } = await harness([
      report('switch_proxy', false, 'DE'),
      report('none', true, 'US')
    ])

    const result = await executor.execute(profile.id, true)
    expect(result.status).toBe('completed')
    expect(result.profile.proxyPoolEntryId).toBe('proxy-us')
    expect(profiles.get(profile.id).proxyCheck?.countryCode).toBe('US')
  })

  it('rolls network identity back when verification fails after proxy switching', async () => {
    const { executor, profiles, profile } = await harness([
      report('switch_proxy', false, 'DE'),
      report('switch_proxy', false, 'DE'),
      report('none', true, 'US')
    ])
    const originalProxy = profiles.get(profile.id).proxy

    const result = await executor.execute(profile.id, true)
    expect(result.status).toBe('rolled_back')
    expect(profiles.get(profile.id).proxy.protocol).toBe(originalProxy.protocol)
    expect(profiles.get(profile.id).proxyPoolEntryId).toBeUndefined()
  })

  it('requires explicit approval for a proxy-switch strategy', async () => {
    const { executor, profile } = await harness([report('switch_proxy', false, 'DE')])
    await expect(executor.execute(profile.id, false)).rejects.toThrow('明确确认')
  })
})
