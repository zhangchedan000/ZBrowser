import { join } from 'node:path'

export interface McpLaunchConfigInput {
  packaged: boolean
  execPath: string
  appPath: string
  resourcesPath?: string
  vaultPath?: string
  serverVersion?: string
}

export interface McpLaunchConfig {
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

export function mcpLaunchConfig(input: McpLaunchConfigInput): McpLaunchConfig {
  if (input.packaged && input.resourcesPath && input.vaultPath) {
    return {
      transport: 'stdio',
      command: input.execPath,
      args: [join(input.resourcesPath, 'app.asar.unpacked', 'out', 'mcp-stdio.cjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ZBROWSER_MCP_VAULT_PATH: input.vaultPath,
        ZBROWSER_MCP_SERVER_VERSION: input.serverVersion ?? 'unknown'
      }
    }
  }

  return {
    transport: 'stdio',
    command: input.execPath,
    args: input.packaged ? ['--mcp-stdio'] : [input.appPath, '--mcp-stdio']
  }
}
