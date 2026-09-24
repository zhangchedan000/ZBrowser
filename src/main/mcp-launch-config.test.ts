import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mcpLaunchConfig } from './mcp-launch-config'

describe('mcp launch config', () => {
  it('uses the packaged Node-mode entry with protected environment', () => {
    expect(mcpLaunchConfig({
      packaged: true,
      execPath: 'C:\\Program Files\\ZBrowser\\ZBrowser.exe',
      appPath: 'C:\\Program Files\\ZBrowser\\resources\\app.asar',
      resourcesPath: 'C:\\Program Files\\ZBrowser\\resources',
      vaultPath: 'C:\\Users\\test\\AppData\\Roaming\\ZBrowser\\vault',
      serverVersion: '0.2.0-beta.3'
    })).toEqual({
      transport: 'stdio',
      command: 'C:\\Program Files\\ZBrowser\\ZBrowser.exe',
      args: [join('C:\\Program Files\\ZBrowser\\resources', 'app.asar.unpacked', 'out', 'mcp-stdio.cjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ZBROWSER_MCP_VAULT_PATH: 'C:\\Users\\test\\AppData\\Roaming\\ZBrowser\\vault',
        ZBROWSER_MCP_SERVER_VERSION: '0.2.0-beta.3'
      }
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
