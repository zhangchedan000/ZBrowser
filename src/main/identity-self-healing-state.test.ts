import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IDENTITY_SELF_HEALING_COOLDOWN_MS,
  IdentitySelfHealingStateStore
} from './identity-self-healing-state'

const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'zbrowser-self-heal-state-'))
  paths.push(root)
  return new IdentitySelfHealingStateStore(root)
}

describe('IdentitySelfHealingStateStore', () => {
  it('persists pending work and applies a cooldown after an attempt', async () => {
    const state = await store()
    await state.observe('p1', {
      signature: 'repair|locale',
      strategyKind: 'repair_configuration',
      reason: 'locale drift'
    })
    const attempt = await state.beginAttempt('p1', 'repair|locale', 'repair_configuration', new Date('2026-09-24T00:00:00.000Z'))
    await state.finishAttempt('p1', attempt.id, 'completed', 'ok', new Date('2026-09-24T00:00:10.000Z'))

    const guard = await state.guard('p1', 'repair|locale', Date.parse('2026-09-24T00:01:00.000Z'))
    expect(guard.allowed).toBe(false)
    expect(guard.cooldownUntil).toBe(new Date(Date.parse('2026-09-24T00:00:00.000Z') + IDENTITY_SELF_HEALING_COOLDOWN_MS).toISOString())
    expect(await state.pending('p1')).toBeNull()
  })

  it('blocks a looping strategy after two consecutive failures', async () => {
    const state = await store()
    const first = await state.beginAttempt('p1', 'switch|US', 'switch_proxy', new Date('2026-09-24T00:00:00.000Z'))
    await state.finishAttempt('p1', first.id, 'rolled_back', 'verify failed', new Date('2026-09-24T00:00:10.000Z'))

    const second = await state.beginAttempt('p1', 'switch|US', 'switch_proxy', new Date('2026-09-24T00:20:00.000Z'))
    await state.finishAttempt('p1', second.id, 'failed', 'proxy failed', new Date('2026-09-24T00:20:10.000Z'))

    const guard = await state.guard('p1', 'switch|US', Date.parse('2026-09-24T00:40:00.000Z'))
    expect(guard.allowed).toBe(false)
    expect(guard.reason).toContain('循环保护')
    expect(guard.consecutiveFailures).toBe(2)
  })
})
