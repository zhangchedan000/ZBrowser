export type FingerprintConsistencyStatus = 'healthy' | 'warning' | 'conflict'

export interface FingerprintConsistencyCheck {
  key: string
  passed: boolean
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface FingerprintConsistencyReport {
  score: number
  status: FingerprintConsistencyStatus
  checks: FingerprintConsistencyCheck[]
}

export interface FingerprintConsistencyInput {
  platform: 'windows' | 'macos'
  hardwareProfileId?: string
  expectedGpu?: string
  runtimeGpu?: string
  fonts?: string[]
  timezone?: string
  language?: string
  webglRenderer?: string
  systemRenderer?: string
}

const WINDOWS_FONTS = [
  'Segoe UI',
  'Consolas',
  'Segoe UI Emoji'
]

const MACOS_FONTS = [
  'Helvetica Neue',
  'Menlo',
  'Apple Color Emoji'
]

const SOFTWARE_RENDERERS = [
  'swiftshader',
  'microsoft basic render driver',
  'warp',
  'llvmpipe',
  'softpipe'
]

function includesAny(value: string | undefined, list: string[]): boolean {
  if (!value) return false
  const normalized = value.toLowerCase()
  return list.some((item) => normalized.includes(item.toLowerCase()))
}

export function evaluateFingerprintConsistency(
  input: FingerprintConsistencyInput
): FingerprintConsistencyReport {
  const checks: FingerprintConsistencyCheck[] = []
  let score = 100

  const expectedFonts = input.platform === 'windows' ? WINDOWS_FONTS : MACOS_FONTS

  if (input.fonts && input.fonts.length > 0) {
    const matched = input.fonts.some((font) => expectedFonts.includes(font))
    checks.push({
      key: 'os-font-consistency',
      passed: matched,
      severity: matched ? 'info' : 'warning',
      message: matched
        ? 'Detected fonts match platform expectations'
        : 'Detected fonts do not strongly match platform expectations'
    })

    if (!matched) score -= 15
  }

  const gpuRenderer = `${input.runtimeGpu ?? ''} ${input.webglRenderer ?? ''} ${input.systemRenderer ?? ''}`

  if (includesAny(gpuRenderer, SOFTWARE_RENDERERS)) {
    checks.push({
      key: 'software-renderer',
      passed: false,
      severity: 'error',
      message: 'Software GPU renderer detected'
    })
    score -= 40
  }

  if (
    input.expectedGpu &&
    input.runtimeGpu &&
    !input.runtimeGpu.toLowerCase().includes(input.expectedGpu.toLowerCase())
  ) {
    checks.push({
      key: 'gpu-match',
      passed: false,
      severity: 'error',
      message: 'Runtime GPU does not match configured persona'
    })
    score -= 30
  }

  if (input.language && input.timezone) {
    checks.push({
      key: 'locale-present',
      passed: true,
      severity: 'info',
      message: 'Locale identity fields available'
    })
  }

  score = Math.max(0, Math.min(100, score))

  return {
    score,
    status:
      score >= 85 ? 'healthy' : score >= 60 ? 'warning' : 'conflict',
    checks
  }
}
