import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionAuditSummary } from './attention-audit'
import { AttentionAuditHistoryStore } from './attention-audit-history'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function summary(index: number): AttentionAuditSummary {
  const startedAt = new Date(Date.UTC(2026, 8, 25, 0, 0, index)).toISOString()
  const completedAt = new Date(Date.UTC(2026, 8, 25, 0, 0, index + 1)).toISOString()
  return {
    startedAt,
    completedAt,
    total: 1,
    completed: 1,
    confirmationRequired: 0,
    failed: 0,
    results: [{
      priority: 1,
      profileId: 'profile-' + index,
      action: 'inspect_process',
      risk: 'read_only',
      status: 'completed',
      startedAt,
      completedAt,
      message: 'checked ' + index,
      result: {
        secretRuntimePayload: 'must-not-be-persisted'
      }
    }]
  }
}

describe('attention audit history store', () => {
  it('persists compact newest-first audit records without raw result payloads', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-attention-history-'))
    temporaryPaths.push(vault)
    const store = new AttentionAuditHistoryStore(vault)

    const first = await store.record(summary(1))
    const second = await store.record(summary(2))
    const listed = await store.list()

    expect(listed.map((record) => record.id)).toEqual([second.id, first.id])
    expect(listed[0]).toMatchObject({
      total: 1,
      completed: 1,
      confirmationRequired: 0,
      failed: 0,
      results: [{
        profileId: 'profile-2',
        status: 'completed',
        message: 'checked 2'
      }]
    })

    const raw = await readFile(join(vault, 'attention-audit-history.json'), 'utf8')
    expect(raw).not.toContain('secretRuntimePayload')
    expect(raw).not.toContain('must-not-be-persisted')
  })

  it('serializes concurrent records through one atomic write queue', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-attention-history-'))
    temporaryPaths.push(vault)
    const store = new AttentionAuditHistoryStore(vault)

    await Promise.all([
      store.record(summary(1)),
      store.record(summary(2)),
      store.record(summary(3))
    ])

    const listed = await store.list()
    expect(listed).toHaveLength(3)
    expect(new Set(listed.map((record) => record.results[0]?.profileId))).toEqual(new Set([
      'profile-1',
      'profile-2',
      'profile-3'
    ]))
  })
})
