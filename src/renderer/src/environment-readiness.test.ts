import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FingerprintRuntimeDiagnosticReport, LaunchDiagnosticReport } from '../../shared/types'
import { summarizeEnvironmentReadiness } from './environment-readiness'

function launchReport(status: 'pass' | 'warning' | 'error'): LaunchDiagnosticReport {
  return {
    profileId: 'profile-1',
    checkedAt: new Date(0).toISOString(),
    ready: status !== 'error',
    checks: [{ key: 'engine', label: '浏览器内核', status, message: 'test' }]
  }
}

function runtimeReport(ready: boolean): FingerprintRuntimeDiagnosticReport {
  return {
    profileId: 'profile-1',
    checkedAt: new Date(0).toISOString(),
    ready,
    checks: [{ key: 'runtime', label: '实际指纹', status: ready ? 'pass' : 'error', message: 'test' }]
  }
}

describe('environment readiness summary', () => {
  it('blocks launch when startup diagnostics contain an error', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('error'), runtimeReport(true))
    expect(result.state).toBe('blocked')
    expect(result.errors).toBeGreaterThan(0)
  })

  it('blocks launch when actual fingerprint verification fails', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('pass'), runtimeReport(false))
    expect(result.state).toBe('blocked')
  })

  it('shows attention when runtime verification has not been run yet', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('pass'))
    expect(result.state).toBe('attention')
    expect(result.title).toContain('可以启动')
  })

  it('reports ready only when local, launch and runtime checks have no blockers or warnings', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('pass'), runtimeReport(true))
    expect(result.state).toBe('ready')
    expect(result.title).toContain('可以启动')
  })

  it('wires profile creation to the unified readiness report', () => {
    const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const modalSource = readFileSync(new URL('./EnvironmentCheckModal.tsx', import.meta.url), 'utf8')
    expect(appSource).toContain('openEnvironmentReadiness(saved, report)')
    expect(modalSource).toContain('window.browserApi.profiles.diagnose(profile.id)')
    expect(modalSource).toContain('启动准备检查')
    expect(modalSource).toContain('查看详细启动诊断')
  })
})
