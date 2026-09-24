import { runMcpStdio } from './mcp-stdio-server'

const vaultPath = process.env.ZBROWSER_MCP_VAULT_PATH
const serverVersion = process.env.ZBROWSER_MCP_SERVER_VERSION ?? 'unknown'

if (!vaultPath) {
  process.stderr.write('ZBROWSER_MCP_VAULT_PATH is required\n')
  process.exitCode = 1
} else {
  runMcpStdio(vaultPath, serverVersion).catch((error) => {
    process.stderr.write(`ZBrowser MCP stdio failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
