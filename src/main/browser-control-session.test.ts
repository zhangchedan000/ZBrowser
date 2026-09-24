import { describe, expect, it } from 'vitest'
import { BrowserControlSession, type CdpTransport, WebSocketCdpTransport } from './browser-control-session'

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


describe('BrowserControlSession page readiness', () => {
  it('treats an interactive document as ready for page automation', async () => {
    const transport: CdpTransport = {
      async send<T>(method: string): Promise<T> {
        if (method === 'Target.createTarget') return { targetId: 'page-1' } as T
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' } as T
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'page-1', type: 'page', url: 'http://127.0.0.1/' } } as T
        if (method === 'Page.navigate') return {} as T
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: {
                url: 'http://127.0.0.1/',
                title: 'E2E',
                readyState: 'interactive'
              }
            }
          } as T
        }
        return {} as T
      },
      close() {}
    }

    const session = new BrowserControlSession(transport)
    await expect(session.open('http://127.0.0.1/')).resolves.toEqual({
      url: 'http://127.0.0.1/',
      title: 'E2E',
      readyState: 'interactive'
    })
  })
})
