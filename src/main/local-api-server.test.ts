import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile, FingerprintRuntimeDiagnosticReport, IdentitySelfHealingSummary, LaunchDiagnosticReport } from '../shared/types'
import { LocalApiServer, localApiPortFromEnvironment } from './local-api-server'
import { IdentityHealthHistoryStore } from './identity-health-history'
import type { LocalApiProfileRuntime } from './browser-launcher'

const temporaryPaths: string[] = []

function fixtureProfile(): BrowserProfile {
  const draft = defaultProfileDraft()
  draft.name = 'Local API profile'
  draft.proxy = {
    protocol: 'http',
    host: 'secret.proxy.example',
    port: 8080,
    username: 'secret-user',
    password: 'secret-password'
  }
  return {
    ...draft,
    id: 'profile-local-api',
    serialNumber: 1,
    favorite: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    status: 'closed'
  }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Local API server', () => {
  it('parses a stable default port and allows ephemeral port zero for test or managed discovery', () => {
    expect(localApiPortFromEnvironment(undefined)).toBeGreaterThan(1024)
    expect(localApiPortFromEnvironment('0')).toBe(0)
    expect(() => localApiPortFromEnvironment('70000')).toThrow()
  })

  it('requires bearer auth, never returns proxy credentials, and controls profiles', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-local-api-'))
    temporaryPaths.push(vault)
    let current = fixtureProfile()
    const profiles = {
      list: (): BrowserProfile[] => [current]
    }
    const launcher = {
      async launch(id: string): Promise<BrowserProfile> {
        expect(id).toBe(current.id)
        current = { ...current, status: 'running' }
        return current
      },
      async close(id: string): Promise<BrowserProfile> {
        expect(id).toBe(current.id)
        current = { ...current, status: 'closed' }
        return current
      },
      async localApiRuntime(id: string): Promise<LocalApiProfileRuntime> {
        expect(id).toBe(current.id)
        return current.status === 'running'
          ? {
              status: 'running',
              pid: 4242,
              cdp: {
                port: 45678,
                httpUrl: 'http://127.0.0.1:45678',
                webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/browser/test'
              }
            }
          : { status: current.status }
      },
      async openPage(id: string, url: string) {
        expect(id).toBe(current.id)
        return { url, title: 'Opened', readyState: 'complete' }
      },
      async pageSnapshot(id: string) {
        expect(id).toBe(current.id)
        return {
          url: 'https://example.test/',
          title: 'Snapshot',
          readyState: 'complete',
          elements: [
            { role: 'textbox', name: 'E2E input', ref: 'p1-e1' },
            { role: 'button', name: 'E2E button', ref: 'p1-e2' }
          ],
          truncated: false
        }
      },
      async clickPageElement(id: string, ref: string) {
        expect(id).toBe(current.id)
        expect(ref).toBe('p1-e2')
        return { url: 'https://example.test/', title: 'Clicked', readyState: 'complete' }
      },
      async typePageElement(id: string, ref: string, text: string, clear = true) {
        expect(id).toBe(current.id)
        expect(ref).toBe('p1-e1')
        expect(text).toBe('hello')
        expect(clear).toBe(true)
        return { url: 'https://example.test/', title: 'Typed', readyState: 'complete' }
      },
      async testProfileProxy(id: string): Promise<BrowserProfile> {
        expect(id).toBe(current.id)
        current = {
          ...current,
          proxyCheck: {
            ok: true,
            latencyMs: 42,
            ip: '203.0.113.42',
            countryCode: 'US',
            timezone: 'America/Los_Angeles',
            latitude: 34.05,
            longitude: -118.24,
            checkedAt: '2026-09-22T00:00:00.000Z'
          }
        }
        return current
      },
      async diagnose(id: string): Promise<LaunchDiagnosticReport> {
        expect(id).toBe(current.id)
        return {
          profileId: id,
          checkedAt: '2026-09-22T00:00:00.000Z',
          ready: true,
          checks: [{ key: 'launch', label: 'launch', status: 'pass', message: 'ok' }]
        }
      },
      async diagnoseKernelRuntime(id: string): Promise<LaunchDiagnosticReport> {
        expect(id).toBe(current.id)
        return {
          profileId: id,
          checkedAt: '2026-09-22T00:00:00.000Z',
          ready: true,
          checks: [{ key: 'kernel', label: 'kernel', status: 'pass', message: 'ok' }]
        }
      },
      async diagnoseFingerprintRuntime(id: string): Promise<FingerprintRuntimeDiagnosticReport> {
        expect(id).toBe(current.id)
        return {
          profileId: id,
          checkedAt: '2026-09-22T00:00:00.000Z',
          ready: true,
          checks: [{ key: 'fingerprint', label: 'fingerprint', status: 'pass', message: 'ok' }]
        }
      }
    }
    const selfHealingStatus: IdentitySelfHealingSummary = {
      mode: 'assisted',
      decision: 'suggest',
      reason: 'test pending repair',
      pending: true,
      attemptsInWindow: 1,
      consecutiveFailures: 0,
      pendingStrategyKind: 'repair_configuration',
      pendingReason: 'repair locale'
    }
    const selfHealing = {
      async status(id: string) {
        expect(id).toBe(current.id)
        return selfHealingStatus
      },
      async statusAll() {
        return { [current.id]: selfHealingStatus }
      },
      async history(id: string) {
        expect(id).toBe(current.id)
        return [{
          id: 'attempt-1',
          startedAt: '2026-09-22T00:00:00.000Z',
          completedAt: '2026-09-22T00:00:01.000Z',
          signature: 'repair_configuration:test',
          strategyKind: 'repair_configuration' as const,
          trigger: 'auto' as const,
          result: 'completed' as const,
          message: 'repaired'
        }]
      },
      async diagnose(id: string) {
        return {
          ...await launcher.diagnoseFingerprintRuntime(id),
          identitySelfHealing: selfHealingStatus
        }
      }
    }
    const healthHistory = new IdentityHealthHistoryStore(vault)
    await healthHistory.record(current.id, {
      checkedAt: '2026-09-22T00:00:00.000Z',
      baselineId: 'baseline-1',
      score: 76,
      risk: 'medium',
      driftDetected: true,
      driftSeverity: 'medium',
      changeCount: 2
    })
    const token = 'test-local-api-token-0123456789-abcdef'
    const server = new LocalApiServer(vault, profiles, launcher, undefined, { port: 0, token, selfHealing })
    const status = await server.start()
    const authorization = { Authorization: 'Bearer ' + token }

    expect(server.publicStatus()).toMatchObject({
      running: true,
      apiVersion: 1,
      host: '127.0.0.1',
      port: status.port,
      url: status.url,
      tokenPath: status.tokenPath,
      capabilities: ['profile-control', 'cdp', 'page-control', 'proxy-test', 'diagnostics', 'self-healing', 'identity-health', 'attention-queue', 'attention-plan', 'attention-audit', 'attention-audit-history']
    })
    expect(JSON.stringify(server.publicStatus())).not.toContain(token)

    try {
      const unauthorized = await fetch(status.url + '/api/v1/profiles')
      expect(unauthorized.status).toBe(401)

      const list = await fetch(status.url + '/api/v1/profiles', { headers: authorization })
      expect(list.status).toBe(200)
      const listText = await list.text()
      expect(listText).toContain('Local API profile')
      expect(listText).toContain('"protocol":"http"')
      expect(listText).not.toContain('secret.proxy.example')
      expect(listText).not.toContain('secret-user')
      expect(listText).not.toContain('secret-password')

      const started = await fetch(status.url + '/api/v1/profiles/' + current.id + '/start', {
        method: 'POST',
        headers: authorization
      })
      expect(started.status).toBe(200)
      expect(await started.json()).toMatchObject({
        profile: { id: current.id, status: 'running' },
        runtime: { pid: 4242, cdp: { port: 45678 } }
      })

      const cdp = await fetch(status.url + '/api/cdp/connect?id=' + current.id, { headers: authorization })
      expect(cdp.status).toBe(200)
      expect(await cdp.json()).toMatchObject({
        profileId: current.id,
        cdp: { httpUrl: 'http://127.0.0.1:45678' }
      })

      const opened = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/open', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/' })
      })
      expect(opened.status).toBe(200)
      expect(await opened.json()).toMatchObject({ page: { title: 'Opened', readyState: 'complete' } })

      const snapshot = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/snapshot', {
        headers: authorization
      })
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({
        page: {
          elements: [
            { role: 'textbox', ref: 'p1-e1' },
            { role: 'button', ref: 'p1-e2' }
          ]
        }
      })

      const typed = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/type', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'p1-e1', text: 'hello' })
      })
      expect(typed.status).toBe(200)

      const clicked = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/click', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'p1-e2' })
      })
      expect(clicked.status).toBe(200)

      const testedProxy = await fetch(status.url + '/api/v1/profiles/' + current.id + '/proxy/test', {
        method: 'POST',
        headers: authorization
      })
      expect(testedProxy.status).toBe(200)
      expect(await testedProxy.json()).toMatchObject({
        profile: {
          id: current.id,
          proxy: {
            checked: true,
            ok: true,
            ip: '203.0.113.42',
            countryCode: 'US',
            timezone: 'America/Los_Angeles'
          }
        }
      })

      for (const [path, key] of [
        ['launch', 'launch'],
        ['kernel-runtime', 'kernel'],
        ['fingerprint-runtime', 'fingerprint']
      ] as const) {
        const diagnostic = await fetch(status.url + '/api/v1/profiles/' + current.id + '/diagnostics/' + path, {
          method: 'POST',
          headers: authorization
        })
        expect(diagnostic.status).toBe(200)
        expect(await diagnostic.json()).toMatchObject({
          profileId: current.id,
          report: {
            ready: true,
            checks: [{ key, status: 'pass' }]
          }
        })
      }

      const attention = await fetch(status.url + '/api/v1/attention', { headers: authorization })
      expect(attention.status).toBe(200)
      expect(await attention.json()).toMatchObject({
        count: 1,
        criticalCount: 0,
        warningCount: 1,
        items: [{
          profileId: current.id,
          serialNumber: current.serialNumber,
          name: current.name,
          level: 'warning',
          issues: expect.arrayContaining([
            expect.objectContaining({ source: 'identity_health', level: 'warning' }),
            expect.objectContaining({ source: 'self_healing', level: 'warning' })
          ])
        }]
      })

      const attentionPlan = await fetch(status.url + '/api/v1/attention/plan', { headers: authorization })
      expect(attentionPlan.status).toBe(200)
      expect(await attentionPlan.json()).toMatchObject({
        count: 1,
        confirmationRequiredCount: 1,
        steps: [{
          priority: 1,
          profileId: current.id,
          action: 'confirm_self_healing',
          risk: 'confirmation_required',
          recommendedTool: 'profile_self_healing_status',
          requiresUserConfirmation: true
        }]
      })

      const attentionAudit = await fetch(status.url + '/api/v1/attention/audit', {
        method: 'POST',
        headers: authorization
      })
      expect(attentionAudit.status).toBe(200)
      const attentionAuditBody = await attentionAudit.json()
      expect(attentionAuditBody).toMatchObject({
        id: expect.any(String),
        total: 1,
        completed: 0,
        confirmationRequired: 1,
        failed: 0,
        results: [{
          priority: 1,
          profileId: current.id,
          action: 'confirm_self_healing',
          risk: 'confirmation_required',
          status: 'confirmation_required'
        }]
      })

      const attentionAuditHistory = await fetch(status.url + '/api/v1/attention/audit/history', {
        headers: authorization
      })
      expect(attentionAuditHistory.status).toBe(200)
      expect(await attentionAuditHistory.json()).toMatchObject({
        history: [{
          id: attentionAuditBody.id,
          total: 1,
          confirmationRequired: 1,
          results: [{
            profileId: current.id,
            status: 'confirmation_required'
          }]
        }]
      })

      const identityHealthList = await fetch(status.url + '/api/v1/identity-health', { headers: authorization })
      expect(identityHealthList.status).toBe(200)
      expect(await identityHealthList.json()).toMatchObject({
        profiles: {
          [current.id]: {
            state: 'attention',
            score: 76,
            risk: 'medium',
            driftDetected: true,
            changeCount: 2,
            trend: {
              sampleCount: 1,
              currentScore: 76,
              direction: 'unknown'
            }
          }
        }
      })

      const identityHealthStatus = await fetch(status.url + '/api/v1/profiles/' + current.id + '/identity-health', { headers: authorization })
      expect(identityHealthStatus.status).toBe(200)
      expect(await identityHealthStatus.json()).toMatchObject({
        profileId: current.id,
        identityHealth: {
          state: 'attention',
          score: 76,
          driftSeverity: 'medium'
        }
      })

      const identityHealthHistory = await fetch(status.url + '/api/v1/profiles/' + current.id + '/identity-health/history', { headers: authorization })
      expect(identityHealthHistory.status).toBe(200)
      expect(await identityHealthHistory.json()).toMatchObject({
        profileId: current.id,
        history: [{
          baselineId: 'baseline-1',
          score: 76,
          risk: 'medium',
          driftDetected: true,
          driftSeverity: 'medium',
          changeCount: 2
        }]
      })

      const healingList = await fetch(status.url + '/api/v1/self-healing', { headers: authorization })
      expect(healingList.status).toBe(200)
      expect(await healingList.json()).toMatchObject({
        profiles: {
          [current.id]: {
            mode: 'assisted',
            pending: true,
            pendingStrategyKind: 'repair_configuration'
          }
        }
      })

      const healingStatus = await fetch(status.url + '/api/v1/profiles/' + current.id + '/self-healing', { headers: authorization })
      expect(healingStatus.status).toBe(200)
      expect(await healingStatus.json()).toMatchObject({
        profileId: current.id,
        selfHealing: { mode: 'assisted', decision: 'suggest', pending: true }
      })

      const healingHistory = await fetch(status.url + '/api/v1/profiles/' + current.id + '/self-healing/history', {
        headers: authorization
      })
      expect(healingHistory.status).toBe(200)
      expect(await healingHistory.json()).toMatchObject({
        profileId: current.id,
        history: [{
          strategyKind: 'repair_configuration',
          trigger: 'auto',
          result: 'completed',
          message: 'repaired'
        }]
      })

      const healingCheck = await fetch(status.url + '/api/v1/profiles/' + current.id + '/self-healing/check', {
        method: 'POST',
        headers: authorization
      })
      expect(healingCheck.status).toBe(200)
      expect(await healingCheck.json()).toMatchObject({
        profileId: current.id,
        selfHealing: { mode: 'assisted', pending: true },
        ready: true
      })

      const stopped = await fetch(status.url + '/api/profile/stop', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: current.id })
      })
      expect(stopped.status).toBe(200)
      expect(await stopped.json()).toMatchObject({ profile: { status: 'closed' } })
    } finally {
      await server.close()
    }
  })
})
