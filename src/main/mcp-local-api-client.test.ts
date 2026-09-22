import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverRunningLocalApi, McpLocalApiError, ZBrowserLocalApiClient } from './mcp-local-api-client'

const roots: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-mcp-local-'))
  roots.push(root)
  const path = join(root, 'vault')
  await mkdir(path)
  return path
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  return { url: `http://127.0.0.1:${address.port}`, port: address.port }
}

describe('MCP Local API discovery', () => {
  it('uses only the fixed loopback metadata and fixed vault token file', async () => {
    const token = 'a'.repeat(40)
    const path = await vault()
    const seenAuth: string[] = []
    const local = await listen((request, response) => {
      seenAuth.push(request.headers.authorization ?? '')
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
    })
    await writeFile(join(path, 'local-api.json'), JSON.stringify({
      schemaVersion: 1,
      host: '127.0.0.1',
      port: local.port,
      url: local.url,
      tokenPath: 'C:/attacker-controlled-token-path'
    }))
    await writeFile(join(path, 'local-api.token'), token)

    const client = await discoverRunningLocalApi(path)
    expect(client.baseUrl).toBe(local.url)
    expect(await client.request('/api/v1/health')).toEqual({ ok: true })
    expect(seenAuth).toEqual([`Bearer ${token}`])
    expect(JSON.stringify(client)).not.toContain(token)
  })

  it('rejects metadata that is not the exact IPv4 loopback endpoint', async () => {
    const path = await vault()
    await writeFile(join(path, 'local-api.token'), 'b'.repeat(40))
    await writeFile(join(path, 'local-api.json'), JSON.stringify({
      schemaVersion: 1,
      host: 'localhost',
      port: 17653,
      url: 'http://localhost:17653'
    }))

    await expect(discoverRunningLocalApi(path)).rejects.toMatchObject<McpLocalApiError>({
      code: 'UNSAFE_LOCAL_API_METADATA'
    })
  })

  it('never allows a caller to turn a tool path into an arbitrary URL', async () => {
    const client = new ZBrowserLocalApiClient('http://127.0.0.1:17653', 'c'.repeat(40))
    await expect(client.request('http://example.com/steal')).rejects.toMatchObject<McpLocalApiError>({
      code: 'INVALID_LOCAL_API_PATH'
    })
    await expect(client.request('/api/v1/../token')).rejects.toMatchObject<McpLocalApiError>({
      code: 'INVALID_LOCAL_API_PATH'
    })
  })
})
