import { describe, expect, it } from 'vitest'
import { handleMcpMessage, MODERN_PROTOCOL_VERSION, TOOLS } from './mcp-stdio-server'

class FakeClient {
  calls: Array<{ path: string; options?: Record<string, unknown> }> = []
  async request(path: string, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ path, options })
    return { ok: true, path }
  }
}

describe('MCP stdio message handler', () => {
  it('supports modern discovery without exposing a token or URL', async () => {
    const client = new FakeClient()
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    }, client, '0.2.0-beta.3')

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        resultType: 'complete',
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'zbrowser',
            version: '0.2.0-beta.3'
          }
        }
      }
    })
    expect(JSON.stringify(response)).not.toContain('Bearer')
    expect(JSON.stringify(response)).not.toContain('local-api.token')
  })

  it('supports the legacy initialize lifecycle and tools list', async () => {
    const client = new FakeClient()
    const initialized = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    }, client, '1.2.3')
    expect(initialized).toMatchObject({
      id: 'init',
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'zbrowser', version: '1.2.3' }
      }
    })

    const listed = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    }, client, '1.2.3')
    expect((listed?.result as { tools: unknown[] }).tools).toHaveLength(TOOLS.length)
    expect(TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'page_snapshot',
      'self_healing_list',
      'profile_self_healing_status',
      'profile_self_healing_check'
    ]))
  })

  it('maps tool calls only to fixed Local API routes', async () => {
    const client = new FakeClient()
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'page_open',
        arguments: {
          profileId: '11111111-1111-1111-1111-111111111111',
          url: 'https://example.com/a'
        }
      }
    }, client, '1.0.0')

    expect(client.calls).toEqual([{
      path: '/api/v1/profiles/11111111-1111-1111-1111-111111111111/page/open',
      options: {
        method: 'POST',
        body: { url: 'https://example.com/a' }
      }
    }])
    expect(response).toMatchObject({
      id: 3,
      result: {
        content: [{ type: 'text' }],
        structuredContent: {
          ok: true,
          path: '/api/v1/profiles/11111111-1111-1111-1111-111111111111/page/open'
        }
      }
    })
    expect((response?.result as { isError?: boolean }).isError).toBeUndefined()
  })

  it('maps Self-Healing tools only to fixed policy-gated Local API routes', async () => {
    const client = new FakeClient()
    await handleMcpMessage({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'self_healing_list', arguments: {} }
    }, client, '1.0.0')
    await handleMcpMessage({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'profile_self_healing_status',
        arguments: { profileId: '11111111-1111-1111-1111-111111111111' }
      }
    }, client, '1.0.0')
    await handleMcpMessage({
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: 'profile_self_healing_check',
        arguments: { profileId: '11111111-1111-1111-1111-111111111111' }
      }
    }, client, '1.0.0')

    expect(client.calls).toEqual([
      { path: '/api/v1/self-healing', options: undefined },
      { path: '/api/v1/profiles/11111111-1111-1111-1111-111111111111/self-healing', options: undefined },
      {
        path: '/api/v1/profiles/11111111-1111-1111-1111-111111111111/self-healing/check',
        options: { method: 'POST', timeoutMs: 120000 }
      }
    ])
  })

  it('returns tool errors as tool results and never turns arguments into arbitrary API paths', async () => {
    const client = new FakeClient()
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'profile_status',
        arguments: { profileId: '../token' }
      }
    }, client, '1.0.0')

    expect(client.calls).toEqual([])
    expect(response).toMatchObject({
      id: 4,
      result: { isError: true }
    })
  })

  it('ignores notifications and returns standard JSON-RPC method errors', async () => {
    const client = new FakeClient()
    expect(await handleMcpMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }, client, '1.0.0')).toBeUndefined()

    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/list'
    }, client, '1.0.0')
    expect(response).toMatchObject({ error: { code: -32601 } })
  })
})
