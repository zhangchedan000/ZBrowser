import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile, FingerprintRuntimeDiagnosticReport, IdentityRepairStrategyExecutionSummary } from '../shared/types'
import { ProfileStore } from './profile-store'
import { IdentitySelfHealingManager } from './identity-self-healing-manager'
import { IdentitySelfHealingStateStore } from './identity-self-healing-state'

const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function repairReport(profileId: string): FingerprintRuntimeDiagnosticReport {
  return {
    profileId,
    checkedAt: new Date().toISOString(),
    ready: false,
    identityDrift: {
      profileId,
      baselineId: 'b1',
      driftDetected: true,
      severity: 'medium',
      confidence: 1,
      changes: [{
        component: 'locale',
        field: 'timezone',
        before: 'America/New_York',
        after: 'Europe/Berlin',
        severity: 'medium'
      }],
      generatedAt: new Date().toISOString()
    },
    identityHealth: { score: 80, risk: 'medium', identity: {}, components: [], generatedAt: new Date().toISOString() },
    identityRepairStrategy: {
      kind: 'repair_configuration',
      reason: 'repair locale',
      affectedSections: ['locale'],
      requiresUserConfirmation: true,
      automaticActionAvailable: true
    },
    checks: []
  }
}

describe('IdentitySelfHealingManager', () => {
  it('auto-executes a low-risk policy for an auto profile', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-self-heal-manager-'))
    paths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.identityIntent = {
      schemaVersion: 1,
      strategy: 'ai_assisted',
      targetCountryCode: 'US',
      selfHealingMode: 'auto'
    }
    const profile = await profiles.create(draft)
    const initial = repairReport(profile.id)
    const healed: FingerprintRuntimeDiagnosticReport = {
      ...initial,
      ready: true,
      identityDrift: { ...initial.identityDrift!, driftDetected: false, severity: 'low', changes: [] },
      identityHealth: { score: 100, risk: 'low', identity: {}, components: [], generatedAt: new Date().toISOString() },
      identityRepairStrategy: {
        kind: 'none',
        reason: 'healthy',
        affectedSections: [],
        requiresUserConfirmation: false,
        automaticActionAvailable: false
      }
    }
    let executions = 0
    const manager = new IdentitySelfHealingManager(
      profiles,
      { diagnoseFingerprintRuntime: async () => initial },
      {
        execute: async (): Promise<IdentityRepairStrategyExecutionSummary & { profile: BrowserProfile }> => {
          executions += 1
          return {
            status: 'completed',
            strategy: initial.identityRepairStrategy!,
            message: 'healed',
            report: healed,
            profile: profiles.get(profile.id)
          }
        }
      },
      new IdentitySelfHealingStateStore(vault)
    )

    const result = await manager.diagnose(profile.id)
    expect(executions).toBe(1)
    expect(result.identitySelfHealing?.lastResult).toBe('completed')
    expect(result.identitySelfHealing?.pending).toBe(false)
  })

  it('does not auto-execute the same repair for an assisted profile', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-self-heal-manager-'))
    paths.push(vault)
    const profiles = new ProfileStore(vault)
    await profiles.initialize()
    const draft = defaultProfileDraft()
    draft.identityIntent = {
      schemaVersion: 1,
      strategy: 'ai_assisted',
      targetCountryCode: 'US',
      selfHealingMode: 'assisted'
    }
    const profile = await profiles.create(draft)
    const initial = repairReport(profile.id)
    let executions = 0
    const manager = new IdentitySelfHealingManager(
      profiles,
      { diagnoseFingerprintRuntime: async () => initial },
      {
        execute: async () => {
          executions += 1
          throw new Error('should not execute')
        }
      },
      new IdentitySelfHealingStateStore(vault)
    )

    const result = await manager.diagnose(profile.id)
    expect(executions).toBe(0)
    expect(result.identitySelfHealing).toMatchObject({ mode: 'assisted', decision: 'suggest', pending: true })
  })
})
