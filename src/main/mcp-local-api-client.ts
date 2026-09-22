import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface LocalApiMetadata {
  schemaVersion: 1
  host: '127.0.0.1'
  port: number
  url: string
}

export class McpLocalApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
}

async function readRegularFile(path: string, label: string): Promise<string> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new McpLocalApiError('LOCAL_API_NOT_RUNNING', `${label} is missing; start ZBrowser first`)
    }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new McpLocalApiError('UNSAFE_LOCAL_API_FILE', `${label} must be a regular file`)
  }
  return readFile(path, 'utf8')
}

export async function discoverRunningLocalApi(vaultPath: string): Promise<ZBrowserLocalApiClient> {
  const metadataPath = join(vaultPath, 'local-api.json')
  const tokenPath = join(vaultPath, 'local-api.token')
  let metadata: Partial<LocalApiMetadata>
  try {
    metadata = JSON.parse(await readRegularFile(metadataPath, 'Local API metadata')) as Partial<LocalApiMetadata>
  } catch (error) {
    if (error instanceof McpLocalApiError) throw error
    throw new McpLocalApiError('INVALID_LOCAL_API_METADATA', 'Local API metadata is invalid')
  }

  if (metadata.schemaVersion !== 1
    || metadata.host !== '127.0.0.1'
    || !validPort(metadata.port)
    || metadata.url !== `http://127.0.0.1:${metadata.port}`) {
    throw new McpLocalApiError('UNSAFE_LOCAL_API_METADATA', 'Local API metadata must point to the exact loopback endpoint')
  }

  const token = (await readRegularFile(tokenPath, 'Local API token')).trim()
  if (token.length < 32 || /\s/.test(token)) {
    throw new McpLocalApiError('INVALID_LOCAL_API_TOKEN', 'Local API token is invalid')
  }
  return new ZBrowserLocalApiClient(metadata.url, token)
}

export class ZBrowserLocalApiClient {
  #token: string

  constructor(readonly baseUrl: string, token: string) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
      throw new McpLocalApiError('UNSAFE_LOCAL_API_URL', 'Local API URL must use exact IPv4 loopback')
    }
    if (token.length < 32 || /\s/.test(token)) {
      throw new McpLocalApiError('INVALID_LOCAL_API_TOKEN', 'Local API token is invalid')
    }
    this.#token = token
  }

  async request(path: string, options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; timeoutMs?: number } = {}): Promise<unknown> {
    if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(path) || path.includes('..')) {
      throw new McpLocalApiError('INVALID_LOCAL_API_PATH', 'Local API path is invalid')
    }
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000)
      })
    } catch {
      throw new McpLocalApiError('LOCAL_API_UNREACHABLE', 'ZBrowser Local API is not reachable')
    }

    let payload: unknown = {}
    const text = await response.text()
    if (text) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        throw new McpLocalApiError('INVALID_LOCAL_API_RESPONSE', 'ZBrowser Local API returned invalid JSON')
      }
    }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const code = typeof body.error === 'string' ? body.error : `HTTP_${response.status}`
      const message = typeof body.message === 'string' ? body.message : `ZBrowser Local API request failed with HTTP ${response.status}`
      throw new McpLocalApiError(code, message)
    }
    return payload
  }
}
