import { discoverRunningLocalApi, McpLocalApiError } from './mcp-local-api-client'

const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

interface McpApiClient {
  request(path: string, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; timeoutMs?: number }): Promise<unknown>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const PROFILE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^[a-zA-Z0-9-]+$'
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'profiles_list',
    description: 'List ZBrowser profiles and their current non-secret status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'profile_status',
    description: 'Get one profile status and local runtime state.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_start',
    description: 'Start one ZBrowser profile.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_stop',
    description: 'Stop one ZBrowser profile.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_proxy_test',
    description: 'Test the proxy already assigned to one profile and update its safe status.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_diagnose_launch',
    description: 'Run pre-launch diagnostics for one profile.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_diagnose_kernel_runtime',
    description: 'Run the kernel runtime diagnostics for one profile.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_diagnose_fingerprint_runtime',
    description: 'Run runtime fingerprint diagnostics for one profile. Auto Self-Healing may execute only when the profile policy explicitly allows a low-risk repair.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'identity_health_list',
    description: 'List current persisted Identity Health summaries for all ZBrowser profiles. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'profile_identity_health',
    description: 'Get one profile Identity Health summary including score, risk, drift and trend direction. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_identity_health_history',
    description: 'Read recent Identity Health trend records for one profile. Read-only and does not start the browser.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'self_healing_list',
    description: 'List persisted Self-Healing mode, pending work, cooldown and loop-guard status for all ZBrowser profiles.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'profile_self_healing_status',
    description: 'Get persisted Self-Healing status for one ZBrowser profile without starting the browser.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_self_healing_check',
    description: 'Run the profile Self-Healing check. It may execute only low-risk actions already authorized by the profile Auto policy; high-risk actions remain confirmation-gated.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'profile_self_healing_history',
    description: 'Read recent persisted Self-Healing attempts for one profile. This is read-only and does not start or modify the browser.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'page_open',
    description: 'Open an HTTP or HTTPS URL in a running ZBrowser profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: PROFILE_ID_SCHEMA,
        url: { type: 'string', minLength: 1, maxLength: 2048 }
      },
      required: ['profileId', 'url'],
      additionalProperties: false
    }
  },
  {
    name: 'page_snapshot',
    description: 'Return the current accessibility-style page snapshot and element refs.',
    inputSchema: {
      type: 'object',
      properties: { profileId: PROFILE_ID_SCHEMA },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'page_type',
    description: 'Type text into an element ref from a page snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: PROFILE_ID_SCHEMA,
        ref: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', maxLength: 100000 },
        clear: { type: 'boolean' }
      },
      required: ['profileId', 'ref', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'page_click',
    description: 'Click an element ref from a page snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: PROFILE_ID_SCHEMA,
        ref: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['profileId', 'ref'],
      additionalProperties: false
    }
  }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function profileId(args: Record<string, unknown>): string {
  const value = args.profileId
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) {
    throw new McpLocalApiError('INVALID_PROFILE_ID', 'profileId is required and must contain only letters, numbers and hyphens')
  }
  return value
}

function stringArgument(args: Record<string, unknown>, key: string, maxLength: number, allowEmpty = false): string {
  const value = args[key]
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > maxLength) {
    throw new McpLocalApiError('INVALID_ARGUMENT', `${key} is invalid`)
  }
  return value
}

function toolPathProfile(id: string, suffix: string): string {
  return '/api/v1/profiles/' + encodeURIComponent(id) + suffix
}

async function callTool(client: McpApiClient, name: string, rawArguments: unknown): Promise<unknown> {
  const args = rawArguments === undefined ? {} : rawArguments
  if (!isRecord(args)) throw new McpLocalApiError('INVALID_ARGUMENTS', 'Tool arguments must be an object')

  switch (name) {
    case 'profiles_list':
      if (Object.keys(args).length) throw new McpLocalApiError('INVALID_ARGUMENTS', 'profiles_list does not accept arguments')
      return client.request('/api/v1/profiles')
    case 'profile_status':
      return client.request(toolPathProfile(profileId(args), '/status'))
    case 'profile_start':
      return client.request(toolPathProfile(profileId(args), '/start'), { method: 'POST' })
    case 'profile_stop':
      return client.request(toolPathProfile(profileId(args), '/stop'), { method: 'POST' })
    case 'profile_proxy_test':
      return client.request(toolPathProfile(profileId(args), '/proxy/test'), { method: 'POST' })
    case 'profile_diagnose_launch':
      return client.request(toolPathProfile(profileId(args), '/diagnostics/launch'), { method: 'POST' })
    case 'profile_diagnose_kernel_runtime':
      return client.request(toolPathProfile(profileId(args), '/diagnostics/kernel-runtime'), { method: 'POST' })
    case 'profile_diagnose_fingerprint_runtime':
      return client.request(toolPathProfile(profileId(args), '/diagnostics/fingerprint-runtime'), { method: 'POST', timeoutMs: 120000 })
    case 'identity_health_list':
      if (Object.keys(args).length) throw new McpLocalApiError('INVALID_ARGUMENTS', 'identity_health_list does not accept arguments')
      return client.request('/api/v1/identity-health')
    case 'profile_identity_health':
      return client.request(toolPathProfile(profileId(args), '/identity-health'))
    case 'profile_identity_health_history':
      return client.request(toolPathProfile(profileId(args), '/identity-health/history'))
    case 'self_healing_list':
      if (Object.keys(args).length) throw new McpLocalApiError('INVALID_ARGUMENTS', 'self_healing_list does not accept arguments')
      return client.request('/api/v1/self-healing')
    case 'profile_self_healing_status':
      return client.request(toolPathProfile(profileId(args), '/self-healing'))
    case 'profile_self_healing_check':
      return client.request(toolPathProfile(profileId(args), '/self-healing/check'), { method: 'POST', timeoutMs: 120000 })
    case 'profile_self_healing_history':
      return client.request(toolPathProfile(profileId(args), '/self-healing/history'))
    case 'page_open': {
      const url = stringArgument(args, 'url', 2048)
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new McpLocalApiError('INVALID_URL', 'url must be a valid HTTP or HTTPS URL')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new McpLocalApiError('INVALID_URL', 'url must use HTTP or HTTPS')
      }
      return client.request(toolPathProfile(profileId(args), '/page/open'), {
        method: 'POST',
        body: { url: parsed.toString() }
      })
    }
    case 'page_snapshot':
      return client.request(toolPathProfile(profileId(args), '/page/snapshot'))
    case 'page_type': {
      const body: Record<string, unknown> = {
        ref: stringArgument(args, 'ref', 200),
        text: stringArgument(args, 'text', 100000, true)
      }
      if (args.clear !== undefined) {
        if (typeof args.clear !== 'boolean') throw new McpLocalApiError('INVALID_ARGUMENT', 'clear must be a boolean')
        body.clear = args.clear
      }
      return client.request(toolPathProfile(profileId(args), '/page/type'), { method: 'POST', body })
    }
    case 'page_click':
      return client.request(toolPathProfile(profileId(args), '/page/click'), {
        method: 'POST',
        body: { ref: stringArgument(args, 'ref', 200) }
      })
    default:
      throw new McpLocalApiError('UNKNOWN_TOOL', 'Unknown tool: ' + name)
  }
}

function modernRequest(message: Record<string, unknown>): boolean {
  if (message.method === 'server/discover') return true
  if (!isRecord(message.params) || !isRecord(message.params._meta)) return false
  return message.params._meta['io.modelcontextprotocol/protocolVersion'] === MODERN_PROTOCOL_VERSION
}

function success(
  id: JsonRpcId,
  result: unknown,
  modern: boolean,
  serverVersion: string
): Record<string, unknown> {
  if (!modern || !isRecord(result)) return { jsonrpc: '2.0', id, result }
  const meta = isRecord(result._meta) ? result._meta : {}
  return {
    jsonrpc: '2.0',
    id,
    result: {
      ...result,
      resultType: typeof result.resultType === 'string' ? result.resultType : 'complete',
      _meta: {
        ...meta,
        'io.modelcontextprotocol/serverInfo': {
          name: 'zbrowser',
          version: serverVersion
        }
      }
    }
  }
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function legacyVersion(params: unknown): string {
  if (!isRecord(params) || typeof params.protocolVersion !== 'string') return LEGACY_PROTOCOL_VERSIONS[0]
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(params.protocolVersion)
    ? params.protocolVersion
    : LEGACY_PROTOCOL_VERSIONS[0]
}

function toolResult(payload: unknown): Record<string, unknown> {
  const structuredContent = isRecord(payload) ? payload : { result: payload }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent
  }
}

function toolError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof McpLocalApiError ? error.code : 'TOOL_FAILED'
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true
  }
}

export async function handleMcpMessage(
  message: unknown,
  client: McpApiClient,
  serverVersion: string
): Promise<Record<string, unknown> | undefined> {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request')
  }
  const id = (typeof message.id === 'string' || typeof message.id === 'number' || message.id === null)
    ? message.id
    : undefined
  const notification = id === undefined
  const modern = modernRequest(message)

  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return undefined
  if (notification) return undefined

  if (message.method === 'server/discover') {
    return success(id, {
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: 'Use ZBrowser tools to control only the local ZBrowser instance. Proxy credentials and Local API tokens are never exposed.'
    }, modern, serverVersion)
  }

  if (message.method === 'initialize') {
    return success(id, {
      protocolVersion: legacyVersion(message.params),
      capabilities: { tools: {} },
      serverInfo: { name: 'zbrowser', version: serverVersion },
      instructions: 'Use ZBrowser tools to control only the local ZBrowser instance. Proxy credentials and Local API tokens are never exposed.'
    }, modern, serverVersion)
  }

  if (message.method === 'ping') return success(id, {}, modern, serverVersion)

  if (message.method === 'tools/list') {
    return success(id, { tools: TOOLS }, modern, serverVersion)
  }

  if (message.method === 'tools/call') {
    if (!isRecord(message.params) || typeof message.params.name !== 'string') {
      return rpcError(id, -32602, 'Invalid tools/call params')
    }
    try {
      const payload = await callTool(client, message.params.name, message.params.arguments)
      return success(id, toolResult(payload), modern, serverVersion)
    } catch (error) {
      return success(id, toolError(error), modern, serverVersion)
    }
  }

  return rpcError(id, -32601, 'Method not found')
}

export async function runMcpStdio(vaultPath: string, serverVersion: string): Promise<void> {
  // Resolve the Local API lazily for each tool request. This keeps discovery/listing usable
  // before the desktop app starts and automatically follows an app restart or ephemeral port.
  // The bearer token lives only inside the short-lived Local API client and is never returned.
  const client: McpApiClient = {
    request: async (path, options) => (await discoverRunningLocalApi(vaultPath)).request(path, options)
  }
  process.stdin.setEncoding('utf8')
  let buffer = ''

  const write = (message: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(message) + '\n')
  }

  for await (const chunk of process.stdin) {
    buffer += chunk
    if (Buffer.byteLength(buffer, 'utf8') > MAX_STDIO_BUFFER_BYTES) {
      write(rpcError(null, -32700, 'Input frame exceeds 10 MB'))
      return
    }

    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue

      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        write(rpcError(null, -32700, 'Parse error'))
        continue
      }
      const response = await handleMcpMessage(message, client, serverVersion)
      if (response) write(response)
    }
  }

  if (buffer.trim()) {
    try {
      const response = await handleMcpMessage(JSON.parse(buffer), client, serverVersion)
      if (response) write(response)
    } catch {
      write(rpcError(null, -32700, 'Parse error'))
    }
  }
}

export { MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS, TOOLS }
