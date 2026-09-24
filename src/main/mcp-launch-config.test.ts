import { describe, expect, it } from 'vitest'
import { mcpLaunchConfig } from './mcp-launch-config'

describe('mcp launch config', () => {
  it('uses the packaged executable directly', () => {
    expect(mcpLaunchConfig({
      packaged: true,
      execPath: 'C:\\Program Files\\ZBrowser\\ZBrowser.exe',
      appPath: 'C:\\Program Files\\ZBrowser\\resources\\app.asar'
    })).toEqual({
      transport: 'stdio',
      command: 'C:\\Program Files\\ZBrowser\\ZBrowser.exe',
      args: ['--mcp-stdio']
    })
  })

  it('passes the app path when running from Electron in development', () => {
    expect(mcpLaunchConfig({
      packaged: false,
      execPath: '/tmp/electron',
      appPath: '/workspace/ZBrowser'
    })).toEqual({
      transport: 'stdio',
      command: '/tmp/electron',
      args: ['/workspace/ZBrowser', '--mcp-stdio']
    })
  })
})
