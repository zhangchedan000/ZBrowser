import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LaunchDiagnosticReport } from '../../shared/types'
import { summarizeEnvironmentReadiness } from './environment-readiness'

function launchReport(status: 'pass' | 'warning' | 'error'): LaunchDiagnosticReport {
  return {
    profileId: 'profile-1',
    checkedAt: new Date(0).toISOString(),
    ready: status !== 'error',
    checks: [{ key: 'engine', label: '浏览器内核', status, message: 'test' }]
  }
}

describe('environment readiness summary', () => {
  it('blocks launch when startup diagnostics contain an error', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('error'))
    expect(result.state).toBe('blocked')
    expect(result.errors).toBeGreaterThan(0)
  })

  it('shows attention for actual launch warnings', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('warning'))
    expect(result.state).toBe('attention')
  })

  it('reports ready when basic startup and local checks have no blockers or warnings', () => {
    const result = summarizeEnvironmentReadiness({ errors: 0, warnings: 0, ok: 3 }, launchReport('pass'))
    expect(result.state).toBe('ready')
    expect(result.title).toContain('可以启动')
  })

  it('keeps environment checks manual instead of running AI fingerprint verification after saving', () => {
    const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const modalSource = readFileSync(new URL('./EnvironmentCheckModal.tsx', import.meta.url), 'utf8')
    expect(appSource).not.toContain('diagnoseFingerprintRuntime(saved.id)')
    expect(modalSource).toContain('window.browserApi.profiles.diagnose(profile.id)')
    expect(modalSource).toContain('启动准备检查')
    expect(modalSource).not.toContain('浏览器实际指纹检测')
    expect(modalSource).toContain('第三方环境检测')
  })
})
