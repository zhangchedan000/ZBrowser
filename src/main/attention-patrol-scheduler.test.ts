import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationAttentionAuditResult } from '../shared/types'
import { SettingsStore } from './settings-store'
import { AttentionPatrolScheduler } from './attention-patrol-scheduler'

const temporaryPaths: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function auditResult(): AutomationAttentionAuditResult {
  return {
    id: 'audit-1',
    startedAt: '2026-09-25T12:15:00.000Z',
    completedAt: '2026-09-25T12:15:01.000Z',
    total: 2,
    completed: 1,
    confirmationRequired: 1,
    failed: 0,
    results: [],
    review: {
      beforeCount: 2,
      afterCount: 1,
      resolvedCount: 1,
      remainingCount: 1,
      newCount: 0,
      resolved: [],
      remaining: [],
      newlyDetected: []
    }
  }
}

describe('AttentionPatrolScheduler', () => {
  it('defaults disabled and schedules only after the user enables it', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-patrol-'))
    temporaryPaths.push(vault)
    const settings = new SettingsStore(vault)
    await settings.initialize()
    const runAudit = vi.fn(async () => auditResult())
    const scheduler = new AttentionPatrolScheduler(settings, runAudit)

    scheduler.start()
    expect(scheduler.status()).toMatchObject({
      enabled: false,
      intervalMinutes: 60,
      running: false,
      nextRunAt: undefined
    })

    await scheduler.configure(true, 15)
    expect(scheduler.status()).toMatchObject({
      enabled: true,
      intervalMinutes: 15,
      nextRunAt: '2026-09-25T12:15:00.000Z'
    })

    await vi.advanceTimersByTimeAsync(15 * 60_000)

    expect(runAudit).toHaveBeenCalledTimes(1)
    expect(scheduler.status()).toMatchObject({
      enabled: true,
      intervalMinutes: 15,
      running: false,
      lastStartedAt: '2026-09-25T12:15:00.000Z',
      lastCompletedAt: '2026-09-25T12:15:00.000Z',
      lastResult: {
        completed: 1,
        confirmationRequired: 1,
        failed: 0,
        resolved: 1,
        remaining: 1,
        newlyDetected: 0
      },
      nextRunAt: '2026-09-25T12:30:00.000Z'
    })
  })

  it('records a failed patrol and schedules the next run instead of stopping', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-patrol-'))
    temporaryPaths.push(vault)
    const settings = new SettingsStore(vault)
    await settings.initialize()
    const runAudit = vi.fn(async () => {
      throw new Error('runtime unavailable')
    })
    const scheduler = new AttentionPatrolScheduler(settings, runAudit)

    await scheduler.configure(true, 15)
    await vi.advanceTimersByTimeAsync(15 * 60_000)

    expect(runAudit).toHaveBeenCalledTimes(1)
    expect(scheduler.status()).toMatchObject({
      enabled: true,
      running: false,
      lastError: 'runtime unavailable',
      nextRunAt: '2026-09-25T12:30:00.000Z'
    })
  })

  it('restores an enabled patrol after an application restart', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-patrol-'))
    temporaryPaths.push(vault)
    const firstSettings = new SettingsStore(vault)
    await firstSettings.initialize()
    const firstScheduler = new AttentionPatrolScheduler(firstSettings, async () => auditResult())

    await firstScheduler.configure(true, 30)
    firstScheduler.stop()

    const reopenedSettings = new SettingsStore(vault)
    await reopenedSettings.initialize()
    const runAudit = vi.fn(async () => auditResult())
    const restartedScheduler = new AttentionPatrolScheduler(reopenedSettings, runAudit)

    restartedScheduler.start()
    expect(restartedScheduler.status()).toMatchObject({
      enabled: true,
      intervalMinutes: 30,
      running: false,
      nextRunAt: '2026-09-25T12:30:00.000Z'
    })

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(runAudit).toHaveBeenCalledTimes(1)
  })

  it('persists configuration and can be disabled without running a pending timer', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'zbrowser-patrol-'))
    temporaryPaths.push(vault)
    const settings = new SettingsStore(vault)
    await settings.initialize()
    const runAudit = vi.fn(async () => auditResult())
    const scheduler = new AttentionPatrolScheduler(settings, runAudit)

    await scheduler.configure(true, 30)
    await scheduler.configure(false, 30)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(runAudit).not.toHaveBeenCalled()
    const reopened = new SettingsStore(vault)
    await reopened.initialize()
    expect(reopened.get()).toMatchObject({
      attentionPatrolEnabled: false,
      attentionPatrolIntervalMinutes: 30
    })
  })
})
