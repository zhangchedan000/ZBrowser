import type {
  EngineStatus,
  FingerprintConfig,
  LaunchDiagnosticCheck,
  ProxyCheckSummary,
  ProxyProtocol,
  RuntimeFingerprintSnapshot
} from './types'
import { resolveFingerprintPersona } from './fingerprint-persona-engine'
import { effectiveNetworkIdentity } from './network-identity'

export interface RuntimeFingerprintProfileLike {
  fingerprint: FingerprintConfig
  proxy: { protocol: ProxyProtocol }
  proxyCheck?: ProxyCheckSummary
}

function add(
  checks: LaunchDiagnosticCheck[],
  key: string,
  label: string,
  status: LaunchDiagnosticCheck['status'],
  message: string
): void {
  checks.push({ key, label, status, message })
}

function exact(
  checks: LaunchDiagnosticCheck[],
  key: string,
  label: string,
  actual: string | number,
  expected: string | number
): void {
  const match = typeof actual === 'number' && typeof expected === 'number'
    ? Math.abs(actual - expected) <= 0.01
    : actual === expected
  add(
    checks,
    key,
    label,
    match ? 'pass' : 'error',
    match ? `${actual}` : `实际 ${actual} / 预期 ${expected}`
  )
}

export function buildRuntimeFingerprintChecks(
  profile: RuntimeFingerprintProfileLike,
  runtime: RuntimeFingerprintSnapshot,
  engine: EngineStatus | null
): LaunchDiagnosticCheck[] {
  const checks: LaunchDiagnosticCheck[] = []
  const fp = profile.fingerprint
  const persona = resolveFingerprintPersona(fp)
  const network = effectiveNetworkIdentity(fp, profile.proxyCheck)

  add(
    checks,
    'runtime-persona-contract',
    'Persona 合同',
    persona.consistency === 'conflict' || persona.consistency === 'unresolved' ? 'warning' : 'pass',
    persona.warnings.length ? persona.warnings.join('；') : persona.label
  )

  exact(
    checks,
    'runtime-platform',
    'navigator.platform',
    runtime.platform,
    fp.platform === 'windows' ? 'Win32' : 'MacIntel'
  )

  if (persona.source === 'host-native') {
    add(
      checks,
      'runtime-hardware-native',
      '本机硬件运行值',
      'pass',
      `${runtime.hardwareConcurrency} 核 · deviceMemory ${runtime.deviceMemory ?? '未暴露'}GB · DPR ${runtime.devicePixelRatio} · ${runtime.screen.width}×${runtime.screen.height}`
    )
  } else {
    exact(checks, 'runtime-hardware-concurrency', 'CPU 核心数', runtime.hardwareConcurrency, persona.hardwareConcurrency)
    if (persona.deviceMemoryGb !== undefined) {
      if (runtime.deviceMemory === undefined) {
        add(checks, 'runtime-device-memory', 'deviceMemory', 'error', `运行时未暴露 deviceMemory，预期 ${persona.deviceMemoryGb}GB`)
      } else {
        exact(checks, 'runtime-device-memory', 'deviceMemory', runtime.deviceMemory, persona.deviceMemoryGb)
      }
    }
    if (persona.devicePixelRatio !== undefined) {
      exact(checks, 'runtime-device-pixel-ratio', 'devicePixelRatio', runtime.devicePixelRatio, persona.devicePixelRatio)
    }
    const screenMatches = runtime.screen.width === persona.screenWidth && runtime.screen.height === persona.screenHeight
    add(
      checks,
      'runtime-screen',
      '屏幕尺寸',
      screenMatches ? 'pass' : 'error',
      screenMatches
        ? `${runtime.screen.width}×${runtime.screen.height}`
        : `实际 ${runtime.screen.width}×${runtime.screen.height} / 预期 ${persona.screenWidth}×${persona.screenHeight}`
    )
    if (persona.colorDepth !== undefined) exact(checks, 'runtime-color-depth', 'colorDepth', runtime.screen.colorDepth, persona.colorDepth)
    if (persona.pixelDepth !== undefined) exact(checks, 'runtime-pixel-depth', 'pixelDepth', runtime.screen.pixelDepth, persona.pixelDepth)
  }

  exact(checks, 'runtime-language', 'navigator.language', runtime.language, network.language)
  exact(checks, 'runtime-timezone', '时区', runtime.timezone, network.timezone)
  if (runtime.languages.length) {
    exact(checks, 'runtime-languages-primary', 'navigator.languages[0]', runtime.languages[0], network.language)
  } else {
    add(checks, 'runtime-languages-primary', 'navigator.languages[0]', 'warning', '运行时未返回 languages 列表')
  }

  if (!engine?.fingerprintKernel || !engine.version) {
    add(checks, 'runtime-user-agent-version', 'User-Agent 版本', 'warning', '当前不是可核验版本的 Fingerprint Chromium 内核')
    return checks
  }

  const expectedVersion = engine.version
  const expectedMajor = expectedVersion.split('.')[0]
  const uaMatches = Boolean(expectedMajor) && new RegExp(`(?:Chrome|Chromium)/${expectedMajor}\\.`).test(runtime.userAgent)
  add(
    checks,
    'runtime-user-agent-version',
    'User-Agent 版本',
    uaMatches ? 'pass' : 'error',
    uaMatches ? `主版本 ${expectedMajor} 与实际内核一致` : `navigator.userAgent 未体现内核主版本 ${expectedMajor}`
  )

  if (!runtime.uaCh.exposed) {
    add(checks, 'runtime-ua-ch-version', 'UA-CH 版本', 'pass', 'navigator.userAgentData 未暴露，不存在旧 UA-CH 版本泄漏面')
    return checks
  }

  const fullVersionMatch = runtime.uaCh.fullVersionList.some((item) => item.version === expectedVersion)
  add(
    checks,
    'runtime-ua-ch-version',
    'UA-CH 版本',
    fullVersionMatch ? 'pass' : 'error',
    fullVersionMatch ? `fullVersionList 包含 ${expectedVersion}` : `fullVersionList 未找到实际内核 ${expectedVersion}`
  )
  exact(
    checks,
    'runtime-ua-ch-platform',
    'UA-CH platform',
    runtime.uaCh.platform ?? '',
    fp.platform === 'windows' ? 'Windows' : 'macOS'
  )

  if (persona.architecture) {
    if (runtime.uaCh.architecture) {
      exact(checks, 'runtime-ua-ch-architecture', 'UA-CH architecture', runtime.uaCh.architecture, persona.architecture)
    } else {
      add(checks, 'runtime-ua-ch-architecture', 'UA-CH architecture', 'warning', '高熵 UA-CH 未返回 architecture')
    }
  }
  if (persona.bitness) {
    if (runtime.uaCh.bitness) {
      exact(checks, 'runtime-ua-ch-bitness', 'UA-CH bitness', runtime.uaCh.bitness, persona.bitness)
    } else {
      add(checks, 'runtime-ua-ch-bitness', 'UA-CH bitness', 'warning', '高熵 UA-CH 未返回 bitness')
    }
  }

  return checks
}
