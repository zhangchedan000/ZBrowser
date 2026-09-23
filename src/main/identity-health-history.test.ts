import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IdentityHealthHistoryStore } from './identity-health-history'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('IdentityHealthHistoryStore', () => {
  it('persists newest-first health trend samples', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zbrowser-health-history-'))
    temporaryPaths.push(root)
    const store = new IdentityHealthHistoryStore(root)

    await store.record('profile-1', {
      checkedAt: '2026-09-23T09:00:00.000Z',
      baselineId: 'baseline-1',
      score: 100,
      risk: 'low',
      driftDetected: false,
      driftSeverity: 'low',
      changeCount: 0
    })
    const records = await store.record('profile-1', {
      checkedAt: '2026-09-23T10:00:00.000Z',
      baselineId: 'baseline-1',
      score: 34,
      risk: 'critical',
      driftDetected: true,
      driftSeverity: 'critical',
      changeCount: 1
    })

    expect(records.map((record) => record.score)).toEqual([34, 100])

    const reopened = new IdentityHealthHistoryStore(root)
    expect((await reopened.list('profile-1')).map((record) => record.score)).toEqual([34, 100])
  })
})
