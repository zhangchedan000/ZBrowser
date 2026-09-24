export interface McpLaunchConfigInput {
  packaged: boolean
  execPath: string
  appPath: string
}

export interface McpLaunchConfig {
  transport: 'stdio'
  command: string
  args: string[]
}

export function mcpLaunchConfig(input: McpLaunchConfigInput): McpLaunchConfig {
  return {
    transport: 'stdio',
    command: input.execPath,
    args: input.packaged ? ['--mcp-stdio'] : [input.appPath, '--mcp-stdio']
  }
}
