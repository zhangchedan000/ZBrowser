import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile, FingerprintRuntimeDiagnosticReport, IdentitySelfHealingSummary } from '../shared/types'
import { IdentityHealthHistoryStore } from './identity-health-history'
import { LocalApiServer } from './local-api-server'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function profile(): BrowserProfile {
  return {
    ...defaultProfileDraft(),
    id: 'audit-concurrency',
    serialNumber: 1,
    name: 'Audit concurrency',
    favorite: false,
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    status: 'closed'
  }
}

describe('attention audit concurrency', () => {
  it('coalesces concurrent manual and scheduled callers into one real audit', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-attention-single-flight-'))
    temporaryPaths.push(vault)
    const current = profile()
    const health = new IdentityHealthHistoryStore(vault)
    await health.record(current.id, {
      checkedAt: '2026-09-25T00:00:00.000Z',
      baselineId: 'baseline-1',
      score: 72,
      risk: 'medium',
      driftDetected: true,
      driftSeverity: 'medium',
      changeCount: 2
    })

    let diagnoseCalls = 0
    let releaseDiagnosis!: () => void
    let enteredDiagnosis!: () => void
    const diagnosisGate = new Promise<void>((resolve) => { releaseDiagnosis = resolve })
    const diagnosisEntered = new Promise<void>((resolve) => { enteredDiagnosis = resolve })
    const selfHealingStatus: IdentitySelfHealingSummary = {
      mode: 'assisted',
      decision: 'suggest',
      reason: 'no pending repair',
      pending: false,
      attemptsInWindow: 0,
      consecutiveFailures: 0
    }

    const launcher = {
      async launch() { throw new Error('not used') },
      async close() { throw new Error('not used') },
      async localApiRuntime() { return { status: 'closed' as const } },
      async openPage() { throw new Error('not used') },
      async pageSnapshot() { throw new Error('not used') },
      async clickPageElement() { throw new Error('not used') },
      async typePageElement() { throw new Error('not used') },
      async testProfileProxy() { throw new Error('not used') },
      async diagnose() { throw new Error('not used') },
      async diagnoseKernelRuntime() { throw new Error('not used') },
      async diagnoseFingerprintRuntime(): Promise<FingerprintRuntimeDiagnosticReport> {
        throw new Error('not used')
      }
    }

    const selfHealing = {
      async status() {
        return selfHealingStatus
      },
      async statusAll() {
        return { [current.id]: selfHealingStatus }
      },
      async history() {
        return []
      },
      async diagnose(profileId: string): Promise<FingerprintRuntimeDiagnosticReport> {
        expect(profileId).toBe(current.id)
        diagnoseCalls += 1
        enteredDiagnosis()
        await diagnosisGate
        return {
          profileId,
          checkedAt: new Date().toISOString(),
          ready: true,
          checks: [{ key: 'fingerprint', label: 'fingerprint', status: 'pass', message: 'ok' }],
          identitySelfHealing: selfHealingStatus
        }
      },
      async executeApproved() {
        throw new Error('not used')
      }
    }

    const server = new LocalApiServer(vault, { list: () => [current] }, launcher, undefined, { selfHealing })

    const concurrentRuns = Array.from({ length: 40 }, () => server.executeAttentionAudit())
    await diagnosisEntered
    expect(diagnoseCalls).toBe(1)

    releaseDiagnosis()
    const results = await Promise.all(concurrentRuns)

    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(diagnoseCalls).toBe(1)
    expect(await server.attentionAuditHistorySummary()).toHaveLength(1)

    await server.executeAttentionAudit()
    expect(diagnoseCalls).toBe(2)
    expect(await server.attentionAuditHistorySummary()).toHaveLength(2)
  })
})
