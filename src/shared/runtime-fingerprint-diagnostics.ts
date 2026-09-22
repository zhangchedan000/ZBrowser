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

export interface RuntimeFingerprintCheckOptions {
  /**
   * False only for CI/headless probes where GPU/font surfaces are not
   * representative of the normal headed browser. Core UA/network checks stay strict.
   */
  renderSurfacesRepresentative?: boolean
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

const WINDOWS_FONT_ANCHORS = ['Segoe UI', 'Consolas', 'Segoe UI Emoji'] as const
const MACOS_FONT_ANCHORS = ['Helvetica Neue', 'Menlo', 'Apple Color Emoji'] as const

function normalizeSurface(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function expectedGpuVendor(gpuModel: string | undefined): 'nvidia' | 'amd' | 'intel' | 'apple' | undefined {
  const normalized = normalizeSurface(gpuModel)
  if (normalized.includes('nvidia')) return 'nvidia'
  if (normalized.includes('amd') || normalized.includes('radeon')) return 'amd'
  if (normalized.includes('intel')) return 'intel'
  if (normalized.includes('apple')) return 'apple'
  return undefined
}

function expectedWebGpuArchitecture(gpuModel: string | undefined): string | undefined {
  const normalized = normalizeSurface(gpuModel)
  if (/rtx 30\d{2}/.test(normalized)) return 'ampere'
  if (/rtx 40\d{2}/.test(normalized)) return 'ada'
  if (/rtx 50\d{2}/.test(normalized)) return 'blackwell'
  return undefined
}

function rendererMatchesGpu(gpuModel: string | undefined, renderer: string): boolean {
  if (!gpuModel || !renderer) return false
  const expected = normalizeSurface(gpuModel)
  const actual = normalizeSurface(renderer)
  const vendor = expectedGpuVendor(gpuModel)
  if (vendor && !actual.includes(vendor)) return false

  const rtx = expected.match(/rtx (\d{4})(?: (ti|super))?/)
  if (rtx) {
    if (!actual.includes(`rtx ${rtx[1]}`)) return false
    if (rtx[2] && !actual.includes(rtx[2])) return false
    return true
  }
  const apple = expected.match(/apple (m\d(?: pro|max|ultra)?)/)
  if (apple) return actual.includes(apple[1])
  return expected.split(' ').filter((token) => token.length >= 3).every((token) => actual.includes(token))
}

function addRenderingSurfaceChecks(
  checks: LaunchDiagnosticCheck[],
  runtime: RuntimeFingerprintSnapshot,
  gpuModel: string | undefined,
  hostNative: boolean,
  representative: boolean
): void {
  const webgl = runtime.webgl
  if (!webgl?.available) {
    add(checks, 'runtime-webgl-renderer', 'WebGL GPU', representative ? 'error' : 'warning',
      representative ? '运行时无法创建 WebGL 上下文' : 'Headless/CI 探测无法提供代表性的 WebGL 上下文')
  } else {
    const renderer = webgl.unmaskedRenderer || webgl.renderer || ''
    const vendor = webgl.unmaskedVendor || webgl.vendor || ''
    if (/swiftshader/i.test(renderer)) {
      add(checks, 'runtime-webgl-renderer', 'WebGL GPU', representative ? 'error' : 'warning',
        representative ? `检测到 SwiftShader：${renderer}` : `Headless/CI 使用 SwiftShader，不代表正常窗口模式：${renderer}`)
    } else if (hostNative || !gpuModel || gpuModel === '本机 GPU') {
      add(checks, 'runtime-webgl-renderer', 'WebGL GPU', 'pass', renderer || '使用本机 WebGL 渲染器')
    } else {
      const matches = rendererMatchesGpu(gpuModel, renderer)
      add(
        checks,
        'runtime-webgl-renderer',
        'WebGL GPU',
        matches ? 'pass' : representative ? 'error' : 'warning',
        matches
          ? `${renderer} · 与 Persona ${gpuModel} 一致`
          : representative
            ? `实际 ${renderer || '未知'} / Persona ${gpuModel}`
            : `Headless/CI renderer 非代表性：${renderer || '未知'} / Persona ${gpuModel}`
      )
      const expectedVendor = expectedGpuVendor(gpuModel)
      if (expectedVendor) {
        const vendorMatches = normalizeSurface(vendor).includes(expectedVendor)
        add(
          checks,
          'runtime-webgl-vendor',
          'WebGL vendor',
          vendorMatches ? 'pass' : representative ? 'error' : 'warning',
          vendorMatches
            ? vendor
            : representative
              ? `实际 ${vendor || '未知'} / 预期 ${expectedVendor}`
              : `Headless/CI vendor 非代表性：${vendor || '未知'} / 预期 ${expectedVendor}`
        )
      }
    }
  }

  const webgpu = runtime.webgpu
  if (!webgpu?.available) {
    add(checks, 'runtime-webgpu', 'WebGPU GPU', 'warning', '当前运行时未提供 WebGPU Adapter，跳过一致性核验')
    return
  }
  if (hostNative || !gpuModel || gpuModel === '本机 GPU') {
    add(checks, 'runtime-webgpu', 'WebGPU GPU', 'pass', [webgpu.vendor, webgpu.architecture].filter(Boolean).join(' · ') || '使用本机 WebGPU Adapter')
    return
  }
  const vendor = expectedGpuVendor(gpuModel)
  if (vendor && webgpu.vendor) {
    const matches = normalizeSurface(webgpu.vendor).includes(vendor)
    add(checks, 'runtime-webgpu-vendor', 'WebGPU vendor', matches ? 'pass' : representative ? 'error' : 'warning',
      matches
        ? webgpu.vendor
        : representative
          ? `实际 ${webgpu.vendor} / 预期 ${vendor}`
          : `Headless/CI vendor 非代表性：${webgpu.vendor} / 预期 ${vendor}`)
  } else {
    add(checks, 'runtime-webgpu-vendor', 'WebGPU vendor', 'warning', 'WebGPU Adapter 未返回可核验 vendor')
  }
  const architecture = expectedWebGpuArchitecture(gpuModel)
  if (architecture) {
    if (webgpu.architecture) {
      const matches = normalizeSurface(webgpu.architecture) === architecture
      add(checks, 'runtime-webgpu-architecture', 'WebGPU architecture', matches ? 'pass' : representative ? 'error' : 'warning',
        matches
          ? webgpu.architecture
          : representative
            ? `实际 ${webgpu.architecture} / 预期 ${architecture}`
            : `Headless/CI architecture 非代表性：${webgpu.architecture} / 预期 ${architecture}`)
    } else {
      add(checks, 'runtime-webgpu-architecture', 'WebGPU architecture', 'warning', `Adapter 未返回 architecture，Persona 预期 ${architecture}`)
    }
  }
}

function addFontSurfaceCheck(
  checks: LaunchDiagnosticCheck[],
  runtime: RuntimeFingerprintSnapshot,
  platform: FingerprintConfig['platform'],
  representative: boolean
): void {
  const fonts = runtime.fonts
  if (!fonts || fonts.method === 'unavailable') {
    add(checks, 'runtime-font-inventory', '系统字体锚点', 'warning', '当前运行时无法执行字体库存探测')
    return
  }
  const detected = new Set(fonts.detected)
  const expected = platform === 'windows' ? WINDOWS_FONT_ANCHORS : MACOS_FONT_ANCHORS
  const opposite = platform === 'windows' ? MACOS_FONT_ANCHORS : WINDOWS_FONT_ANCHORS
  const expectedHits = expected.filter((font) => detected.has(font))
  const oppositeHits = opposite.filter((font) => detected.has(font))

  if (expectedHits.length === 0) {
    add(
      checks,
      'runtime-font-inventory',
      '系统字体锚点',
      representative ? 'error' : 'warning',
      representative
        ? `未检测到 ${platform === 'windows' ? 'Windows' : 'macOS'} 核心字体锚点；实际检测到：${fonts.detected.join('、') || '无'}`
        : `Headless/CI 字体库存非代表性；检测到：${fonts.detected.join('、') || '无'}`
    )
    return
  }
  const status: LaunchDiagnosticCheck['status'] = expectedHits.length >= 2
    ? (oppositeHits.length >= 2 ? 'warning' : 'pass')
    : 'warning'
  add(
    checks,
    'runtime-font-inventory',
    '系统字体锚点',
    status,
    `匹配 ${expectedHits.length}/${expected.length}：${expectedHits.join('、')}${oppositeHits.length >= 2 ? `；同时检测到另一系统字体：${oppositeHits.join('、')}` : ''}`
  )
}

export function buildRuntimeFingerprintChecks(
  profile: RuntimeFingerprintProfileLike,
  runtime: RuntimeFingerprintSnapshot,
  engine: EngineStatus | null,
  options: RuntimeFingerprintCheckOptions = {}
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

  const representativeRenderSurfaces = options.renderSurfacesRepresentative !== false
  addRenderingSurfaceChecks(checks, runtime, persona.gpuModel, persona.source === 'host-native', representativeRenderSurfaces)
  addFontSurfaceCheck(checks, runtime, fp.platform, representativeRenderSurfaces)

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
