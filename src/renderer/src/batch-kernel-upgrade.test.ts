import { describe, expect, it, vi } from 'vitest'
import { defaultProfileDraft } from '../../shared/defaults'
import type { BrowserProfileView, KernelRelease, LaunchDiagnosticReport } from '../../shared/types'
import { executeBatchKernelUpgrades, planBatchKernelUpgrades } from './batch-kernel-upgrade'

function profile(
  id: string,
  version: string,
  family: 'fingerprint-chromium' | 'custom' = 'fingerprint-chromium',
  status: BrowserProfileView['status'] = 'closed'
): BrowserProfileView {
  const draft = defaultProfileDraft()
  return {
    ...draft,
    id,
    serialNumber: Number(id.replace(/\D/g, '')) || 1,
    name: `环境 ${id}`,
    kernelVersion: version,
    kernelFamily: family,
    status,
    favorite: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    proxy: { protocol: 'direct', host: '', username: '', password: '', passwordStored: false }
  }
}

function kernel(version: string, origin: KernelRelease['origin'] = 'release'): KernelRelease {
  return {
    version,
    publishedAt: '2026-09-22T00:00:00.000Z',
    assetName: 'test.zip',
    downloadUrl: '',
    size: 1,
    sha256: 'a'.repeat(64),
    installed: true,
    remoteAvailable: false,
    origin,
    executable: `C:/kernels/${version}/chrome.exe`
  }
}

function diagnostic(ready: boolean): LaunchDiagnosticReport {
  return {
    profileId: 'p1',
    checkedAt: '2026-09-22T00:00:00.000Z',
    ready,
    checks: ready
      ? [{ key: 'engine', label: '浏览器内核', status: 'pass', message: '可执行' }]
      : [{ key: 'engine', label: '浏览器内核', status: 'error', message: '启动失败' }]
  }
}

describe('batch kernel upgrades', () => {
  it('plans same-family upgrades and records running/latest/family-mismatch skips', () => {
    const plans = planBatchKernelUpgrades([
      profile('p1', '144.0.0.1'),
      profile('p2', '148.0.0.1'),
      profile('p3', '144.0.0.1', 'custom'),
      profile('p4', '144.0.0.1', 'fingerprint-chromium', 'running'),
      profile('p5', '150.0.0.1')
    ], [
      kernel('144.0.0.1'),
      kernel('148.0.0.1'),
      kernel('149.0.0.1', 'local-build')
    ])

    expect(plans[0]).toMatchObject({ targetVersion: '148.0.0.1', targetFamily: 'fingerprint-chromium' })
    expect(plans[1].skipReason).toContain('系列不同')
    expect(plans[2]).toMatchObject({ targetVersion: '149.0.0.1', targetFamily: 'custom' })
    expect(plans[3].skipReason).toContain('运行中')
    expect(plans[4].skipReason).toContain('已是')
  })

  it('executes sequentially and pauses remaining candidates after the first upgrade failure', async () => {
    const plans = planBatchKernelUpgrades([
      profile('p1', '144.0.0.1'),
      profile('p2', '144.0.0.1'),
      profile('p3', '144.0.0.1')
    ], [kernel('144.0.0.1'), kernel('148.0.0.1')])

    const upgrade = vi.fn()
      .mockResolvedValueOnce({ profile: { ...plans[0].profile, kernelVersion: '148.0.0.1' } })
      .mockRejectedValueOnce(new Error('第二个环境升级失败'))

    const result = await executeBatchKernelUpgrades(plans, {
      upgrade,
      diagnose: vi.fn().mockResolvedValue(diagnostic(true)),
      rollback: vi.fn()
    }, { testFirst: false })

    expect(upgrade).toHaveBeenCalledTimes(2)
    expect(result.paused).toBe(true)
    expect(result.items.map((item) => item.status)).toEqual(['success', 'failed', 'skipped'])
    expect(result.items[2].reason).toContain('批量升级已暂停')
  })

  it('upgrades one test profile, rolls it back on failed diagnostics, and does not touch the rest', async () => {
    const plans = planBatchKernelUpgrades([
      profile('p1', '144.0.0.1'),
      profile('p2', '144.0.0.1')
    ], [kernel('144.0.0.1'), kernel('148.0.0.1')])

    const upgrade = vi.fn().mockResolvedValue({
      profile: { ...plans[0].profile, kernelVersion: '148.0.0.1' }
    })
    const rollback = vi.fn().mockResolvedValue(plans[0].profile)

    const result = await executeBatchKernelUpgrades(plans, {
      upgrade,
      diagnose: vi.fn().mockResolvedValue(diagnostic(false)),
      rollback
    }, { testFirst: true })

    expect(upgrade).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledWith('p1')
    expect(result.items[0]).toMatchObject({ status: 'failed' })
    expect(result.items[0].reason).toContain('已自动回滚升级前状态')
    expect(result.items[1]).toMatchObject({ status: 'skipped' })
  })

  it('rolls back the first test profile when diagnostics throw an error', async () => {
    const plans = planBatchKernelUpgrades([
      profile('p1', '144.0.0.1'),
      profile('p2', '144.0.0.1')
    ], [kernel('144.0.0.1'), kernel('148.0.0.1')])

    const rollback = vi.fn().mockResolvedValue(plans[0].profile)
    const result = await executeBatchKernelUpgrades(plans, {
      upgrade: vi.fn().mockResolvedValue({
        profile: { ...plans[0].profile, kernelVersion: '148.0.0.1' }
      }),
      diagnose: vi.fn().mockRejectedValue(new Error('诊断服务不可用')),
      rollback
    }, { testFirst: true })

    expect(rollback).toHaveBeenCalledWith('p1')
    expect(result.items[0].status).toBe('failed')
    expect(result.items[0].reason).toContain('启动诊断执行失败')
    expect(result.items[0].reason).toContain('已自动回滚升级前状态')
    expect(result.items[1].status).toBe('skipped')
  })

  it('continues after the first test profile passes diagnostics', async () => {
    const plans = planBatchKernelUpgrades([
      profile('p1', '144.0.0.1'),
      profile('p2', '144.0.0.1')
    ], [kernel('144.0.0.1'), kernel('148.0.0.1')])

    const upgrade = vi.fn(async (id: string) => ({
      profile: { ...plans.find((plan) => plan.profile.id === id)!.profile, kernelVersion: '148.0.0.1' }
    }))
    const diagnose = vi.fn().mockResolvedValue(diagnostic(true))

    const result = await executeBatchKernelUpgrades(plans, {
      upgrade,
      diagnose,
      rollback: vi.fn()
    }, { testFirst: true })

    expect(upgrade).toHaveBeenCalledTimes(2)
    expect(diagnose).toHaveBeenCalledTimes(1)
    expect(result.paused).toBe(false)
    expect(result.items.map((item) => item.status)).toEqual(['success', 'success'])
    expect(result.items[0].reason).toContain('通过启动诊断')
  })
})
