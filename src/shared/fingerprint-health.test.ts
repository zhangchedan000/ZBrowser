import { describe, expect, it } from 'vitest'
import { buildFingerprintHealthReport } from './fingerprint-health'

const check = (
  key: string,
  status: 'pass' | 'warning' | 'error',
  message = 'test'
) => ({
  key,
  label: key,
  status,
  message
})

describe('fingerprint health', () => {
  it('returns healthy for clean diagnostics', () => {
    const report = buildFingerprintHealthReport([
      check('runtime-platform', 'pass')
    ])

    expect(report.score).toBe(100)
    expect(report.level).toBe('healthy')
    expect(report.issues).toHaveLength(0)
  })

  it('downgrades GPU and timezone conflicts', () => {
    const report = buildFingerprintHealthReport([
      check('runtime-webgl-renderer', 'error', 'GPU mismatch'),
      check('runtime-timezone', 'warning', 'timezone mismatch')
    ])

    expect(report.score).toBeLessThan(100)
    expect(report.level).toBe('warning')
    expect(report.issues).toHaveLength(2)
  })
})
