import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { BrowserProfile } from '../shared/types'
import type { Logger } from './app-logger'
import type { LocalApiProfileRuntime } from './browser-launcher'
import type { BrowserControlSession } from './browser-control-session'
import { safeErrorText } from './redaction'

export const DEFAULT_LOCAL_API_PORT = 17653
const LOCAL_API_HOST = '127.0.0.1'
const MAX_REQUEST_BODY_BYTES = 16 * 1024

interface LocalApiProfileStore {
  list(): BrowserProfile[]
}

interface LocalApiLauncher {
  launch(id: string): Promise<BrowserProfile>
  close(id: string): Promise<BrowserProfile>
  localApiRuntime(id: string): Promise<LocalApiProfileRuntime>
  openPage(id: string, url: string): ReturnType<BrowserControlSession['open']>
  pageSnapshot(id: string): ReturnType<BrowserControlSession['snapshot']>
  clickPageElement(id: string, ref: string): ReturnType<BrowserControlSession['click']>
  typePageElement(id: string, ref: string, text: string, clear?: boolean): ReturnType<BrowserControlSession['type']>
}

export interface LocalApiServerOptions {
  port?: number
  token?: string
}

export interface LocalApiServerStatus {
  host: string
  port: number
  url: string
  tokenPath: string
  metadataPath: string
}

class LocalApiHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export function localApiPortFromEnvironment(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_LOCAL_API_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('ZBROWSER_LOCAL_API_PORT must be an integer between 0 and 65535')
  }
  return port
}

function secureTokenMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string') return ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? ''
}

function profileSummary(profile: BrowserProfile): Record<string, unknown> {
  return {
    id: profile.id,
    serialNumber: profile.serialNumber,
    name: profile.name,
    status: profile.status,
    favorite: profile.favorite,
    kernelVersion: profile.kernelVersion,
    kernelFamily: profile.kernelFamily,
    proxy: {
      protocol: profile.proxy.protocol,
      checked: Boolean(profile.proxyCheck),
      ok: profile.proxyCheck?.ok,
      ip: profile.proxyCheck?.ok ? profile.proxyCheck.ip : undefined,
      countryCode: profile.proxyCheck?.ok ? profile.proxyCheck.countryCode : undefined,
      timezone: profile.proxyCheck?.ok ? profile.proxyCheck.timezone : undefined
    },
    fingerprint: {
      platform: profile.fingerprint.platform,
      hardwareProfileId: profile.fingerprint.hardwareProfileId,
      hardwarePersonaId: profile.fingerprint.hardwarePersonaId,
      language: profile.fingerprint.language,
      timezone: profile.fingerprint.timezone
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new LocalApiHttpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large')
    }
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new LocalApiHttpError(400, 'INVALID_JSON', 'Request body must be a JSON object')
  }
}

export class LocalApiServer {
  private server?: Server
  private token = ''
  private port?: number
  readonly tokenPath: string
  readonly metadataPath: string

  constructor(
    private readonly vaultPath: string,
    private readonly profiles: LocalApiProfileStore,
    private readonly launcher: LocalApiLauncher,
    private readonly logger?: Logger,
    private readonly options: LocalApiServerOptions = {}
  ) {
    this.tokenPath = join(vaultPath, 'local-api.token')
    this.metadataPath = join(vaultPath, 'local-api.json')
  }

  async start(): Promise<LocalApiServerStatus> {
    if (this.server && this.port !== undefined) return this.status()
    this.token = await this.loadOrCreateToken()
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.logger?.error('Local API request failed', {
          method: request.method,
          path: request.url,
          error: safeErrorText(error)
        })
        if (!response.headersSent) {
          const status = error instanceof LocalApiHttpError ? error.status : 409
          const code = error instanceof LocalApiHttpError ? error.code : 'REQUEST_FAILED'
          this.sendJson(response, status, { error: code, message: safeErrorText(error) })
        } else {
          response.end()
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(this.options.port ?? DEFAULT_LOCAL_API_PORT, LOCAL_API_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Local API did not receive a TCP listening address')
    }
    this.server = server
    this.port = address.port
    const status = this.status()
    try {
      await mkdir(this.vaultPath, { recursive: true })
      await writeFile(this.metadataPath, JSON.stringify({
        schemaVersion: 1,
        host: status.host,
        port: status.port,
        url: status.url,
        tokenPath: status.tokenPath,
        startedAt: new Date().toISOString()
      }, null, 2), { encoding: 'utf8', mode: 0o600 })
      return status
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    await rm(this.metadataPath, { force: true }).catch(() => undefined)
    if (!server) return
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private status(): LocalApiServerStatus {
    if (this.port === undefined) throw new Error('Local API is not running')
    return {
      host: LOCAL_API_HOST,
      port: this.port,
      url: 'http://' + LOCAL_API_HOST + ':' + this.port,
      tokenPath: this.tokenPath,
      metadataPath: this.metadataPath
    }
  }

  private async loadOrCreateToken(): Promise<string> {
    const configured = this.options.token?.trim()
    if (configured) {
      if (configured.length < 32 || /\s/.test(configured)) {
        throw new Error('ZBROWSER_LOCAL_API_TOKEN must contain at least 32 non-whitespace characters')
      }
      return configured
    }

    try {
      const existing = (await readFile(this.tokenPath, 'utf8')).trim()
      if (existing.length >= 32 && !/\s/.test(existing)) return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const token = randomBytes(32).toString('base64url')
    await mkdir(this.vaultPath, { recursive: true })
    await writeFile(this.tokenPath, token + '\n', { encoding: 'utf8', mode: 0o600 })
    return token
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!secureTokenMatch(bearerToken(request), this.token)) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      this.sendJson(response, 401, { error: 'UNAUTHORIZED', message: 'Bearer token required' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://' + LOCAL_API_HOST)
    const method = request.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/api/v1/health') {
      this.sendJson(response, 200, { ok: true, service: 'ZBrowser Local API', version: 1 })
      return
    }
    if (method === 'GET' && (url.pathname === '/api/v1/profiles' || url.pathname === '/api/profile/list')) {
      this.sendJson(response, 200, { profiles: this.profiles.list().map(profileSummary) })
      return
    }

    const pageRoute = url.pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/page\/(open|snapshot|click|type)$/)
    if (pageRoute) {
      const id = decodeURIComponent(pageRoute[1])
      const action = pageRoute[2]
      if (action === 'snapshot' && method === 'GET') {
        this.profile(id)
        this.sendJson(response, 200, { profileId: id, page: await this.launcher.pageSnapshot(id) })
        return
      }
      if (method !== 'POST') throw new LocalApiHttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
      const body = await readJsonBody(request)
      if (action === 'open') {
        const pageUrl = typeof body.url === 'string' ? body.url : ''
        if (!pageUrl) throw new LocalApiHttpError(400, 'URL_REQUIRED', 'HTTP or HTTPS URL is required')
        this.profile(id)
        this.sendJson(response, 200, { profileId: id, page: await this.launcher.openPage(id, pageUrl) })
        return
      }
      const ref = typeof body.ref === 'string' ? body.ref : ''
      if (!ref) throw new LocalApiHttpError(400, 'ELEMENT_REF_REQUIRED', 'Element ref is required')
      this.profile(id)
      if (action === 'click') {
        this.sendJson(response, 200, { profileId: id, page: await this.launcher.clickPageElement(id, ref) })
        return
      }
      if (typeof body.text !== 'string') {
        throw new LocalApiHttpError(400, 'TEXT_REQUIRED', 'Text is required')
      }
      if (body.clear !== undefined && typeof body.clear !== 'boolean') {
        throw new LocalApiHttpError(400, 'INVALID_CLEAR', 'clear must be a boolean')
      }
      this.sendJson(response, 200, {
        profileId: id,
        page: await this.launcher.typePageElement(id, ref, body.text, body.clear !== false)
      })
      return
    }

    const versioned = url.pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/(status|start|stop|cdp)$/)
    if (versioned) {
      const id = decodeURIComponent(versioned[1])
      const action = versioned[2]
      if (action === 'status' && method === 'GET') return void this.sendJson(response, 200, await this.profileStatus(id))
      if (action === 'start' && method === 'POST') return void this.sendJson(response, 200, await this.startProfile(id))
      if (action === 'stop' && method === 'POST') return void this.sendJson(response, 200, await this.stopProfile(id))
      if (action === 'cdp' && method === 'GET') return void this.sendJson(response, 200, await this.cdpProfile(id))
      throw new LocalApiHttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    }

    if (url.pathname === '/api/profile/status' && method === 'GET') {
      return void this.sendJson(response, 200, await this.profileStatus(this.queryId(url)))
    }
    if (url.pathname === '/api/cdp/connect' && method === 'GET') {
      return void this.sendJson(response, 200, await this.cdpProfile(this.queryId(url)))
    }
    if ((url.pathname === '/api/profile/start' || url.pathname === '/api/profile/stop') && method === 'POST') {
      const body = await readJsonBody(request)
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new LocalApiHttpError(400, 'PROFILE_ID_REQUIRED', 'Profile id is required')
      const payload = url.pathname.endsWith('/start') ? await this.startProfile(id) : await this.stopProfile(id)
      this.sendJson(response, 200, payload)
      return
    }

    throw new LocalApiHttpError(404, 'NOT_FOUND', 'Local API route not found')
  }

  private queryId(url: URL): string {
    const id = url.searchParams.get('id')?.trim() ?? ''
    if (!id) throw new LocalApiHttpError(400, 'PROFILE_ID_REQUIRED', 'Profile id is required')
    return id
  }

  private profile(id: string): BrowserProfile {
    const profile = this.profiles.list().find((item) => item.id === id)
    if (!profile) throw new LocalApiHttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found')
    return profile
  }

  private async profileStatus(id: string): Promise<Record<string, unknown>> {
    const profile = this.profile(id)
    return {
      profile: profileSummary(profile),
      runtime: await this.launcher.localApiRuntime(id)
    }
  }

  private async startProfile(id: string): Promise<Record<string, unknown>> {
    this.profile(id)
    const profile = await this.launcher.launch(id)
    const runtime = await this.waitForRuntime(id)
    return { profile: profileSummary(profile), runtime }
  }

  private async stopProfile(id: string): Promise<Record<string, unknown>> {
    this.profile(id)
    const profile = await this.launcher.close(id)
    return { profile: profileSummary(profile), runtime: await this.launcher.localApiRuntime(id) }
  }

  private async cdpProfile(id: string): Promise<Record<string, unknown>> {
    this.profile(id)
    const runtime = await this.launcher.localApiRuntime(id)
    if (!runtime.cdp) {
      throw new LocalApiHttpError(409, 'CDP_NOT_READY', 'Profile is not running with an available loopback CDP endpoint')
    }
    return { profileId: id, cdp: runtime.cdp }
  }

  private async waitForRuntime(id: string): Promise<LocalApiProfileRuntime> {
    const attempts = process.platform === 'win32' ? 50 : 1
    let runtime = await this.launcher.localApiRuntime(id)
    for (let attempt = 1; attempt < attempts && !runtime.cdp; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      runtime = await this.launcher.localApiRuntime(id)
    }
    return runtime
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded) return
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.end(JSON.stringify(payload))
  }
}
