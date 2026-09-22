import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { LocalApiServer, localApiPortFromEnvironment } from './local-api-server'
import type { LocalApiProfileRuntime } from './browser-launcher'

const temporaryPaths: string[] = []

function fixtureProfile(): BrowserProfile {
  const draft = defaultProfileDraft()
  draft.name = 'Local API profile'
  draft.proxy = {
    protocol: 'http',
    host: 'secret.proxy.example',
    port: 8080,
    username: 'secret-user',
    password: 'secret-password'
  }
  return {
    ...draft,
    id: 'profile-local-api',
    serialNumber: 1,
    favorite: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    status: 'closed'
  }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Local API server', () => {
  it('parses a stable default port and allows ephemeral port zero for test or managed discovery', () => {
    expect(localApiPortFromEnvironment(undefined)).toBeGreaterThan(1024)
    expect(localApiPortFromEnvironment('0')).toBe(0)
    expect(() => localApiPortFromEnvironment('70000')).toThrow()
  })

  it('requires bearer auth, never returns proxy credentials, and controls profiles', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-local-api-'))
    temporaryPaths.push(vault)
    let current = fixtureProfile()
    const profiles = {
      list: (): BrowserProfile[] => [current]
    }
    const launcher = {
      async launch(id: string): Promise<BrowserProfile> {
        expect(id).toBe(current.id)
        current = { ...current, status: 'running' }
        return current
      },
      async close(id: string): Promise<BrowserProfile> {
        expect(id).toBe(current.id)
        current = { ...current, status: 'closed' }
        return current
      },
      async localApiRuntime(id: string): Promise<LocalApiProfileRuntime> {
        expect(id).toBe(current.id)
        return current.status === 'running'
          ? {
              status: 'running',
              pid: 4242,
              cdp: {
                port: 45678,
                httpUrl: 'http://127.0.0.1:45678',
                webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/browser/test'
              }
            }
          : { status: current.status }
      }
    }
    const token = 'test-local-api-token-0123456789-abcdef'
    const server = new LocalApiServer(vault, profiles, launcher, undefined, { port: 0, token })
    const status = await server.start()
    const authorization = { Authorization: 'Bearer ' + token }

    try {
      const unauthorized = await fetch(status.url + '/api/v1/profiles')
      expect(unauthorized.status).toBe(401)

      const list = await fetch(status.url + '/api/v1/profiles', { headers: authorization })
      expect(list.status).toBe(200)
      const listText = await list.text()
      expect(listText).toContain('Local API profile')
      expect(listText).toContain('"protocol":"http"')
      expect(listText).not.toContain('secret.proxy.example')
      expect(listText).not.toContain('secret-user')
      expect(listText).not.toContain('secret-password')

      const started = await fetch(status.url + '/api/v1/profiles/' + current.id + '/start', {
        method: 'POST',
        headers: authorization
      })
      expect(started.status).toBe(200)
      expect(await started.json()).toMatchObject({
        profile: { id: current.id, status: 'running' },
        runtime: { pid: 4242, cdp: { port: 45678 } }
      })

      const cdp = await fetch(status.url + '/api/cdp/connect?id=' + current.id, { headers: authorization })
      expect(cdp.status).toBe(200)
      expect(await cdp.json()).toMatchObject({
        profileId: current.id,
        cdp: { httpUrl: 'http://127.0.0.1:45678' }
      })

      const stopped = await fetch(status.url + '/api/profile/stop', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: current.id })
      })
      expect(stopped.status).toBe(200)
      expect(await stopped.json()).toMatchObject({ profile: { status: 'closed' } })
    } finally {
      await server.close()
    }
  })
})
