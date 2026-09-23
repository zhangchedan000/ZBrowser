import { describe, expect, it } from 'vitest'
import { compareIdentityBaseline } from './identity-drift-engine'

const base = {
  browser: { chromium: '144' },
  hardware: { cpu: 8, memory: 16 },
  gpu: { renderer: 'NVIDIA RTX 4060', vendor: 'NVIDIA' },
  rendering: { canvas: 'stable' },
  network: { country: 'US', ip: '1.1.1.1' },
  locale: { timezone: 'America/New_York' }
}

describe('identity drift engine', () => {
  it('returns healthy when baseline and runtime match', () => {
    const report = compareIdentityBaseline('profile', 'baseline', base, structuredClone(base))
    expect(report.driftDetected).toBe(false)
    expect(report.severity).toBe('low')
  })

  it('detects critical GPU drift', () => {
    const current = structuredClone(base)
    current.gpu.renderer = 'SwiftShader'

    const report = compareIdentityBaseline('profile', 'baseline', base, current)

    expect(report.driftDetected).toBe(true)
    expect(report.severity).toBe('critical')
    expect(report.changes[0]?.component).toBe('gpu')
  })

  it('detects network and locale drift', () => {
    const current = structuredClone(base)
    current.network.country = 'DE'
    current.locale.timezone = 'Europe/Berlin'

    const report = compareIdentityBaseline('profile', 'baseline', base, current)

    expect(report.changes.map((item) => item.component)).toContain('network')
    expect(report.changes.map((item) => item.component)).toContain('locale')
  })
})
