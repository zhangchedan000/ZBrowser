import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { McpLaunchConfig } from './mcp-launch-config'
import { MODERN_PROTOCOL_VERSION } from './mcp-stdio-server'

export interface McpConnectionCheckResult {
  ok: boolean
  checkedAt: string
  latencyMs: number
  protocolVersion: string
  serverName?: string
  serverVersion?: string
  toolCount: number
  message: string
}

interface JsonRpcResponse {
  id?: string | number | null
  result?: unknown
  error?: { code?: number; message?: string }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function summarizeMcpProbe(
  initializeResponse: unknown,
  toolsResponse: unknown,
  latencyMs: number
): McpConnectionCheckResult {
  const init = record(initializeResponse)
  const initResult = record(init?.result)
  const serverInfo = record(initResult?.serverInfo)
  const listed = record(toolsResponse)
  const toolsResult = record(listed?.result)
  const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : undefined
  const protocolVersion = typeof initResult?.protocolVersion === 'string'
    ? initResult.protocolVersion
    : MODERN_PROTOCOL_VERSION
  const serverName = typeof serverInfo?.name === 'string' ? serverInfo.name : undefined
  const serverVersion = typeof serverInfo?.version === 'string' ? serverInfo.version : undefined

  if (init?.error || !serverName || !tools) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      latencyMs,
      protocolVersion,
      serverName,
      serverVersion,
      toolCount: tools?.length ?? 0,
      message: 'MCP stdio 响应不完整，初始化或工具列表校验失败'
    }
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    latencyMs,
    protocolVersion,
    serverName,
    serverVersion,
    toolCount: tools.length,
    message: `MCP stdio 已连通，发现 ${tools.length} 个工具`
  }
}

export async function checkMcpConnection(
  config: McpLaunchConfig,
  timeoutMs = 12_000
): Promise<McpConnectionCheckResult> {
  const startedAt = Date.now()
  const child = spawn(config.command, config.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ZBROWSER_MCP_STDIO: '1' }
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 4000) stderr += chunk
  })

  const pending = new Map<string | number, {
    resolve: (value: JsonRpcResponse) => void
    reject: (error: Error) => void
  }>()

  const onLine = (line: string): void => {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    waiter.resolve(message)
  }
  lines.on('line', onLine)

  const request = (id: string | number, method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} 超时`))
      }, timeoutMs)
      timer.unref()
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  const exitPromise = new Promise<never>((_resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`MCP 子进程提前退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${stderr.trim() ? ': ' + stderr.trim() : ''}`))
    })
  })

  try {
    const initialize = await Promise.race([
      request('probe-init', 'initialize', {
        protocolVersion: MODERN_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'zbrowser-self-check', version: '1' }
      }),
      exitPromise
    ])
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const tools = await Promise.race([
      request('probe-tools', 'tools/list'),
      exitPromise
    ])
    return summarizeMcpProbe(initialize, tools, Date.now() - startedAt)
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      protocolVersion: MODERN_PROTOCOL_VERSION,
      toolCount: 0,
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    lines.close()
    for (const waiter of pending.values()) waiter.reject(new Error('MCP 自检已结束'))
    pending.clear()
    child.stdin.end()
    if (!child.killed) child.kill()
  }
}
