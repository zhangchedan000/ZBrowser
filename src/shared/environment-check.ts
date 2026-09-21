import type { BrowserProfileView, EngineStatus } from './types'
import { fingerprintVersionWarning } from './fingerprint-consistency'
import { hardwareIdentityWarnings, hardwareProfile } from './hardware-profiles'
import { effectiveNetworkIdentity, localeForCountry } from './network-identity'

export type EnvironmentCheckLevel = 'ok' | 'warning' | 'error' | 'info'

export interface EnvironmentCheckItem {
  key: string
  label: string
  level: EnvironmentCheckLevel
  summary: string
  detail?: string
}

function olderThan(iso: string | undefined, maxAgeMs: number): boolean {
  if (!iso) return true
  const time = Date.parse(iso)
  return !Number.isFinite(time) || Date.now() - time > maxAgeMs
}

export function buildEnvironmentChecks(
  profile: BrowserProfileView,
  engine: EngineStatus | null
): EnvironmentCheckItem[] {
  const items: EnvironmentCheckItem[] = []
  const proxy = profile.proxyCheck
  const fp = profile.fingerprint
  const network = effectiveNetworkIdentity(fp, proxy)
  const usingProxy = profile.proxy.protocol !== 'direct'

  if (!usingProxy) {
    items.push({
      key: 'proxy',
      label: '网络出口',
      level: 'info',
      summary: '当前使用本地直连',
      detail: '如果该环境用于固定地区账号，建议绑定稳定代理并完成出口检测。'
    })
  } else if (!proxy) {
    items.push({
      key: 'proxy',
      label: '网络出口',
      level: 'warning',
      summary: '代理尚未检测',
      detail: '先执行代理检测，确认出口 IP、地区、时区与线路状态。'
    })
  } else if (!proxy.ok) {
    items.push({
      key: 'proxy',
      label: '网络出口',
      level: 'error',
      summary: '代理检测失败',
      detail: proxy.error ?? '无法连接代理出口'
    })
  } else {
    const stale = olderThan(proxy.checkedAt, 24 * 60 * 60 * 1000)
    items.push({
      key: 'proxy',
      label: '网络出口',
      level: stale ? 'warning' : 'ok',
      summary: [proxy.ip, proxy.countryCode, proxy.city].filter(Boolean).join(' · ') || '代理可用',
      detail: stale ? '检测结果已超过 24 小时，建议重新检测。' : `延迟 ${proxy.latencyMs} ms`
    })
  }

  if (proxy?.ok && proxy.timezone) {
    items.push({
      key: 'timezone',
      label: '时区一致性',
      level: network.timezone === proxy.timezone ? 'ok' : 'warning',
      summary: network.timezone === proxy.timezone
        ? `浏览器与出口均为 ${proxy.timezone}`
        : `浏览器 ${network.timezone} / 出口 ${proxy.timezone}`,
      detail: network.timezone === proxy.timezone ? undefined : '时区与代理出口不一致，容易形成明显环境冲突。'
    })
  } else {
    items.push({
      key: 'timezone',
      label: '时区',
      level: 'info',
      summary: network.timezone,
      detail: '代理检测成功后可进一步核对出口时区。'
    })
  }

  const expectedLocale = localeForCountry(proxy?.countryCode)
  if (proxy?.ok && expectedLocale) {
    const matches = network.language === expectedLocale.language
    items.push({
      key: 'language',
      label: '语言 / 地区',
      level: matches ? 'ok' : 'warning',
      summary: matches
        ? `${network.language} 与 ${proxy.countryCode} 匹配`
        : `${network.language} / 建议 ${expectedLocale.language}`,
      detail: matches ? undefined : '浏览器主语言与代理国家的常用语言设置不一致。'
    })
  } else {
    items.push({
      key: 'language',
      label: '浏览器语言',
      level: 'info',
      summary: network.language
    })
  }

  if (usingProxy) {
    items.push({
      key: 'webrtc',
      label: 'WebRTC',
      level: fp.webrtcPolicy === 'proxy_only' ? 'ok' : 'warning',
      summary: fp.webrtcPolicy === 'proxy_only' ? '已限制非代理 UDP' : '存在真实网络暴露风险',
      detail: fp.webrtcPolicy === 'proxy_only' ? undefined : '代理环境建议使用“仅代理”策略，并在 BrowserLeaks WebRTC 页面复核。'
    })
  } else {
    items.push({
      key: 'webrtc',
      label: 'WebRTC',
      level: 'info',
      summary: fp.webrtcPolicy === 'proxy_only' ? '仅代理策略' : fp.webrtcPolicy === 'public_only' ? '仅公网接口' : '默认策略'
    })
  }

  const hardware = hardwareProfile(fp.hardwareProfileId)
  if (hardware) {
    const matches = hardware.platform === fp.platform
    items.push({
      key: 'hardware',
      label: '硬件模板',
      level: matches ? 'ok' : 'error',
      summary: matches ? hardware.label : `${hardware.label} 与 ${fp.platform} 冲突`,
      detail: matches ? undefined : '硬件模板与操作系统平台不一致。'
    })
  }

  const hardwareWarnings = hardwareIdentityWarnings(fp)
  items.push({
    key: 'hardware-identity',
    label: '硬件身份一致性',
    level: hardwareWarnings.length ? 'warning' : 'ok',
    summary: hardwareWarnings.length
      ? `${hardwareWarnings.length} 项硬件指纹冲突`
      : [
          fp.architecture && fp.bitness ? `${fp.architecture}-${fp.bitness}` : undefined,
          fp.deviceMemoryGb ? `deviceMemory ${fp.deviceMemoryGb}GB` : undefined,
          fp.devicePixelRatio ? `DPR ${fp.devicePixelRatio}` : undefined
        ].filter(Boolean).join(' · ') || '使用模板默认硬件身份',
    detail: hardwareWarnings.length
      ? hardwareWarnings.join('；')
      : 'CPU 架构、浏览器可见内存、DPR 与硬件画像保持一致。'
  })

  const versionIssue = fingerprintVersionWarning(fp.brandVersion, engine)
  items.push({
    key: 'browser-version',
    label: '浏览器版本',
    level: versionIssue ? 'warning' : engine?.fingerprintKernel ? 'ok' : 'warning',
    summary: versionIssue ?? (engine?.fingerprintKernel ? `指纹内核 ${engine.version ?? '已连接'}` : '当前不是指纹内核'),
    detail: !versionIssue && !engine?.fingerprintKernel ? '系统浏览器只能用于兼容测试，不能完整应用指纹参数。' : undefined
  })

  const screenPlausible = fp.screenWidth >= 800 && fp.screenWidth <= 7680 && fp.screenHeight >= 600 && fp.screenHeight <= 4320
  items.push({
    key: 'screen',
    label: '屏幕参数',
    level: screenPlausible ? 'ok' : 'warning',
    summary: `${fp.screenWidth} × ${fp.screenHeight}`,
    detail: screenPlausible ? undefined : '屏幕尺寸超出常见桌面范围，请确认是否为有意设置。'
  })

  items.push({
    key: 'seed',
    label: '指纹种子',
    level: Number.isInteger(fp.seed) && fp.seed > 0 ? 'ok' : 'warning',
    summary: String(fp.seed),
    detail: '同一环境应长期保持同一 Seed；复制环境时应生成新的 Seed。'
  })

  return items
}

export function environmentCheckSummary(items: EnvironmentCheckItem[]): {
  errors: number
  warnings: number
  ok: number
} {
  return {
    errors: items.filter((item) => item.level === 'error').length,
    warnings: items.filter((item) => item.level === 'warning').length,
    ok: items.filter((item) => item.level === 'ok').length
  }
}
