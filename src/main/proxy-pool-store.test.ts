import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyPoolStore } from './proxy-pool-store'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zbrowser-proxy-pool-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ProxyPoolStore', () => {
  it('stores proxy passwords privately and exposes only a password marker', async () => {
    const vault = await root()
    const store = new ProxyPoolStore(vault, undefined, async () => ({
      ok: true,
      ip: '203.0.113.10',
      latencyMs: 120,
      countryCode: 'US',
      timezone: 'America/Los_Angeles',
      latitude: 34.05,
      longitude: -118.24,
      geoConfidence: 'consensus'
    }))
    await store.initialize()
    const created = await store.create({
      name: 'US 01',
      tags: ['shop'],
      proxy: { protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'secret' }
    })
    expect(created.proxy.password).toBe('')
    expect(created.proxy.passwordStored).toBe(true)
    expect(store.proxyConfig(created.id).password).toBe('secret')
    expect(await readFile(join(vault, 'proxy-pool.json'), 'utf8')).toContain('secret')
  })

  it('tracks failures, quarantines after three consecutive failures and recovers on success', async () => {
    const vault = await root()
    let calls = 0
    const store = new ProxyPoolStore(vault, undefined, async () => {
      calls += 1
      if (calls <= 3) return { ok: false, latencyMs: 10, error: 'offline', failureKind: 'connection' }
      return {
        ok: true,
        ip: '198.51.100.8',
        latencyMs: 80,
        countryCode: 'US',
        timezone: 'America/New_York',
        latitude: 40.7,
        longitude: -74,
        geoConfidence: 'consensus'
      }
    })
    await store.initialize()
    const entry = await store.create({
      name: 'US 02',
      tags: [],
      proxy: { protocol: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: '' }
    })
    await store.test(entry.id)
    await store.test(entry.id)
    expect((await store.test(entry.id)).health).toBe('quarantined')
    const recovered = await store.test(entry.id)
    expect(recovered.health).toBe('healthy')
    expect(recovered.stats.consecutiveFailures).toBe(0)
    expect(recovered.stats.successRate).toBe(0.25)
    expect(recovered.score).toBeGreaterThan(0)
  })

  it('rejects duplicate proxy identities', async () => {
    const store = new ProxyPoolStore(await root())
    await store.initialize()
    await store.create({
      name: 'A',
      tags: [],
      proxy: { protocol: 'http', host: 'proxy.example.com', port: 8000, username: 'same', password: 'a' }
    })
    await expect(store.create({
      name: 'B',
      tags: [],
      proxy: { protocol: 'http', host: 'proxy.example.com', port: 8000, username: 'same', password: 'b' }
    })).rejects.toThrow('已存在')
  })
})
