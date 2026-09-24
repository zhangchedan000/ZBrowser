import { describe, expect, it } from 'vitest'
import { summarizeMcpProbe } from './mcp-connection-check'

describe('MCP connection probe summary', () => {
  it('accepts a valid initialize and tools/list exchange', () => {
    const result = summarizeMcpProbe({
      jsonrpc: '2.0',
      id: 'probe-init',
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'zbrowser', version: '0.2.0-beta.3' }
      }
    }, {
      jsonrpc: '2.0',
      id: 'probe-tools',
      result: {
        tools: [{ name: 'profiles_list' }, { name: 'page_open' }]
      }
    }, 42)

    expect(result).toMatchObject({
      ok: true,
      latencyMs: 42,
      protocolVersion: '2025-11-25',
      serverName: 'zbrowser',
      serverVersion: '0.2.0-beta.3',
      toolCount: 2
    })
  })

  it('fails closed when the MCP response is incomplete', () => {
    const result = summarizeMcpProbe({
      jsonrpc: '2.0',
      id: 'probe-init',
      result: { protocolVersion: '2025-11-25' }
    }, {
      jsonrpc: '2.0',
      id: 'probe-tools',
      result: {}
    }, 10)

    expect(result).toMatchObject({
      ok: false,
      latencyMs: 10,
      toolCount: 0
    })
  })
})
