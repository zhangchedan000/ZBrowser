import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { explainRuntimeError, runtimeErrorDetail, userFacingErrorText } from './user-facing-error'

describe('user-facing runtime errors', () => {
  it('classifies real Chromium proxy page failures as network problems', () => {
    const result = explainRuntimeError(new Error('Chromium 实际代理链路无法访问外部网页：net::ERR_TUNNEL_CONNECTION_FAILED'))
    expect(result.title).toBe('代理或网络连接异常')
    expect(result.action).toContain('实际网页连通性')
  })

  it('classifies Chinese kernel errors as kernel problems', () => {
    const result = explainRuntimeError(new Error('环境绑定的内核 134.0.0 不可用，请先安装该版本'))
    expect(result.title).toBe('浏览器内核无法使用')
    expect(result.action).toContain('内核管理')
  })

  it('classifies member permission errors before generic runtime errors', () => {
    const result = explainRuntimeError(new Error('当前子账号没有该环境的操作权限'))
    expect(result.title).toBe('当前账号没有操作权限')
    expect(result.action).toContain('主账号')
  })

  it('classifies identity errors and keeps the original detail', () => {
    const message = 'Runtime Identity Verify 未通过：fingerprint drift detected'
    const result = explainRuntimeError(new Error(message))
    expect(result.title).toBe('身份环境检查未通过')
    expect(result.detail).toBe(message)
  })

  it('classifies orphan process conflicts with a concrete recovery action', () => {
    const result = explainRuntimeError(new Error('该环境仍有异常遗留进程，请先点击“结束遗留”'))
    expect(result.title).toBe('环境仍被浏览器进程占用')
    expect(result.action).toContain('结束')
  })

  it('strips IPC wrapper text but preserves diagnostic detail', () => {
    const wrapped = "Error invoking remote method 'profiles:launch': Error: 没有找到浏览器内核"
    expect(runtimeErrorDetail(new Error(wrapped))).toBe('没有找到浏览器内核')
    expect(userFacingErrorText(new Error(wrapped))).toContain('详细原因：没有找到浏览器内核')
  })

  it('routes App message errors through the user-facing mapper', () => {
    const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(appSource).toContain("import { userFacingErrorText } from './user-facing-error'")
    expect(appSource).toContain('messageApi.error(userFacingErrorText(error)')
    expect(appSource).not.toContain('messageApi.error(humanError(error)')
  })
})
