import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelRegistry, type ManagedKernelRecord } from './kernel-registry'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-kernel-registry-'))
  temporaryRoots.push(root)
  return root
}

function record(version = '144.0.7559.132'): ManagedKernelRecord {
  return {
    id: `fingerprint-chromium-${version}`,
    family: 'fingerprint-chromium',
    version,
    platform: `${process.platform}-${process.arch}`,
    executablePath: join('C:', 'kernels', version, 'chrome.exe'),
    installedAt: '2026-09-21T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    enabled: true
  }
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('KernelRegistry', () => {
  it('persists valid records without sharing mutable empty state', async () => {
    const firstRoot = await temporaryRoot()
    const secondRoot = await temporaryRoot()
    const first = new KernelRegistry(firstRoot)
    const second = new KernelRegistry(secondRoot)

    await first.register(record())
    expect(await first.list()).toEqual([record()])
    expect(await second.list()).toEqual([])

    const persisted = JSON.parse(await readFile(join(firstRoot, 'kernel-registry.json'), 'utf8'))
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.kernels).toHaveLength(1)
  })

  it('quarantines malformed registry data and recovers from manifests-derived state', async () => {
    const root = await temporaryRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'kernel-registry.json'), '{"schemaVersion":1,"kernels":[{"id":"bad"}]}')

    const registry = new KernelRegistry(root)
    expect(await registry.list()).toEqual([])

    const names = await readdir(root)
    expect(names.some((name) => name.startsWith('kernel-registry.corrupt-') && name.endsWith('.json'))).toBe(true)

    await registry.register(record())
    expect(await registry.list()).toEqual([record()])
  })

  it('rejects invalid records before writing them', async () => {
    const root = await temporaryRoot()
    const registry = new KernelRegistry(root)
    const invalid = { ...record(), version: '../144' } as ManagedKernelRecord

    await expect(registry.register(invalid)).rejects.toThrow('内核注册记录无效')
    expect(await registry.list()).toEqual([])
  })
})
