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
      },
      async openPage(id: string, url: string) {
        expect(id).toBe(current.id)
        return { url, title: 'Opened', readyState: 'complete' }
      },
      async pageSnapshot(id: string) {
        expect(id).toBe(current.id)
        return {
          url: 'https://example.test/',
          title: 'Snapshot',
          readyState: 'complete',
          elements: [
            { role: 'textbox', name: 'E2E input', ref: 'p1-e1' },
            { role: 'button', name: 'E2E button', ref: 'p1-e2' }
          ],
          truncated: false
        }
      },
      async clickPageElement(id: string, ref: string) {
        expect(id).toBe(current.id)
        expect(ref).toBe('p1-e2')
        return { url: 'https://example.test/', title: 'Clicked', readyState: 'complete' }
      },
      async typePageElement(id: string, ref: string, text: string, clear = true) {
        expect(id).toBe(current.id)
        expect(ref).toBe('p1-e1')
        expect(text).toBe('hello')
        expect(clear).toBe(true)
        return { url: 'https://example.test/', title: 'Typed', readyState: 'complete' }
      },
      async testProfileProxy(id: string): Promise<BrowserProfile> {
        expect(id).toBe(current.id)
        current = {
          ...current,
          proxyCheck: {
            ok: true,
            latencyMs: 42,
            ip: '203.0.113.42',
            countryCode: 'US',
            timezone: 'America/Los_Angeles',
            latitude: 34.05,
            longitude: -118.24,
            checkedAt: '2026-09-22T00:00:00.000Z'
          }
        }
        return current
      },
      async diagnose(id: string) {
        expect(id).toBe(current.id)
        return {
          profileId: id,
          checkedAt: '2026-09-22T00:00:00.000Z',
          ready: true,
          checks: [{ key: 'launch', label: 'launch', status: 'pass', message: 'ok' }]
        }
      },
      async diagnoseKernelRuntime(id: string) {
        expect(id).toBe(current.id)
        return {
          profileId: id,
          checkedAt: '2026-09-22T00:00:00.000Z',
          ready: true,
          checks: [{ key: 'kernel', label: 'kernel', status: 'pass', message: 'ok' }]
        }
      },
      async diagnoseFingerprintRuntime(id: string) {
        expect(id).toBe(current.id)
        return {
          profileId: id,
          checkedAt: '2026-09-22T00:00:00.000Z',
          ready: true,
          checks: [{ key: 'fingerprint', label: 'fingerprint', status: 'pass', message: 'ok' }]
        }
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

      const opened = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/open', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/' })
      })
      expect(opened.status).toBe(200)
      expect(await opened.json()).toMatchObject({ page: { title: 'Opened', readyState: 'complete' } })

      const snapshot = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/snapshot', {
        headers: authorization
      })
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({
        page: {
          elements: [
            { role: 'textbox', ref: 'p1-e1' },
            { role: 'button', ref: 'p1-e2' }
          ]
        }
      })

      const typed = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/type', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'p1-e1', text: 'hello' })
      })
      expect(typed.status).toBe(200)

      const clicked = await fetch(status.url + '/api/v1/profiles/' + current.id + '/page/click', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'p1-e2' })
      })
      expect(clicked.status).toBe(200)

      const testedProxy = await fetch(status.url + '/api/v1/profiles/' + current.id + '/proxy/test', {
        method: 'POST',
        headers: authorization
      })
      expect(testedProxy.status).toBe(200)
      expect(await testedProxy.json()).toMatchObject({
        profile: {
          id: current.id,
          proxy: {
            checked: true,
            ok: true,
            ip: '203.0.113.42',
            countryCode: 'US',
            timezone: 'America/Los_Angeles'
          }
        }
      })

      for (const [path, key] of [
        ['launch', 'launch'],
        ['kernel-runtime', 'kernel'],
        ['fingerprint-runtime', 'fingerprint']
      ] as const) {
        const diagnostic = await fetch(status.url + '/api/v1/profiles/' + current.id + '/diagnostics/' + path, {
          method: 'POST',
          headers: authorization
        })
        expect(diagnostic.status).toBe(200)
        expect(await diagnostic.json()).toMatchObject({
          profileId: current.id,
          report: {
            ready: true,
            checks: [{ key, status: 'pass' }]
          }
        })
      }

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
