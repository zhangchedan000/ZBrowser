import { describe, expect, it } from 'vitest'
import { WebSocketCdpTransport } from './browser-control-session'

describe('WebSocketCdpTransport security boundary', () => {
  it('rejects non-loopback CDP endpoints before opening a socket', async () => {
    await expect(WebSocketCdpTransport.connect('ws://example.com:9222/devtools/browser/test'))
      .rejects.toThrow('127.0.0.1')
    await expect(WebSocketCdpTransport.connect('wss://127.0.0.1:9222/devtools/browser/test'))
      .rejects.toThrow('127.0.0.1')
    await expect(WebSocketCdpTransport.connect('ws://user:pass@127.0.0.1:9222/devtools/browser/test'))
      .rejects.toThrow('127.0.0.1')
  })

  it('rejects loopback websocket paths outside the Chromium browser endpoint', async () => {
    await expect(WebSocketCdpTransport.connect('ws://127.0.0.1:9222/not-devtools'))
      .rejects.toThrow('127.0.0.1')
  })
})
