import { compareKernelVersions, kernelFamilyForRelease, kernelReleaseMatchesPin, newerCompatibleKernelVersion } from '../../shared/kernel-version'
import type { BrowserProfileView, KernelFamily, KernelRelease, LaunchDiagnosticReport } from '../../shared/types'

export type BatchKernelUpgradeStatus = 'success' | 'failed' | 'skipped'

export interface BatchKernelUpgradePlan {
  profile: BrowserProfileView
  targetVersion?: string
  targetFamily?: KernelFamily
  skipReason?: string
}

export interface BatchKernelUpgradeItemResult {
  profileId: string
  name: string
  status: BatchKernelUpgradeStatus
  fromVersion?: string
  toVersion?: string
  reason: string
}

interface BatchKernelUpgradeDependencies {
  upgrade: (id: string, version: string, family: KernelFamily) => Promise<{ profile: BrowserProfileView }>
  diagnose: (id: string) => Promise<LaunchDiagnosticReport>
  rollback: (id: string) => Promise<BrowserProfileView>
  onProfileChanged?: (profile: BrowserProfileView) => void
}

export interface BatchKernelUpgradeRunResult {
  items: BatchKernelUpgradeItemResult[]
  paused: boolean
}

function isEditable(profile: BrowserProfileView): boolean {
  return profile.status === 'closed' || profile.status === 'error'
}

function higherInstalledOtherFamily(
  profile: BrowserProfileView,
  kernels: KernelRelease[]
): KernelRelease | undefined {
  if (!profile.kernelVersion || !profile.kernelFamily) return undefined
  return kernels
    .filter((kernel) => Boolean(kernel.executable)
      && kernelFamilyForRelease(kernel) !== profile.kernelFamily
      && compareKernelVersions(kernel.version, profile.kernelVersion) > 0)
    .sort((first, second) => compareKernelVersions(second.version, first.version))[0]
}

export function planBatchKernelUpgrades(
  profiles: BrowserProfileView[],
  kernels: KernelRelease[]
): BatchKernelUpgradePlan[] {
  return profiles.map((profile) => {
    if (!isEditable(profile)) {
      return { profile, skipReason: `运行中或正在切换状态（${profile.status}）` }
    }
    if (!profile.kernelVersion || !profile.kernelFamily) {
      return { profile, skipReason: '未固定内核版本/系列' }
    }

    const targetVersion = newerCompatibleKernelVersion(profile.kernelVersion, profile.kernelFamily, kernels)
    if (!targetVersion) {
      const otherFamily = higherInstalledOtherFamily(profile, kernels)
      if (otherFamily) {
        return {
          profile,
          skipReason: `系列不同：仅发现 ${kernelFamilyForRelease(otherFamily)} ${otherFamily.version} 的更高版本`
        }
      }
      return { profile, skipReason: '已是当前已安装同系列内核的最新版本' }
    }

    const target = kernels.find((kernel) => kernelReleaseMatchesPin(kernel, targetVersion, profile.kernelFamily))
    if (!target) return { profile, skipReason: '未找到可用的同系列升级内核' }

    return {
      profile,
      targetVersion,
      targetFamily: kernelFamilyForRelease(target)
    }
  })
}

function diagnosticFailure(report: LaunchDiagnosticReport): string {
  const errors = report.checks.filter((check) => check.status === 'error')
  if (!errors.length) return '升级后启动诊断未通过'
  return errors.map((check) => `${check.label}：${check.message}`).join('；')
}

export async function executeBatchKernelUpgrades(
  plans: BatchKernelUpgradePlan[],
  dependencies: BatchKernelUpgradeDependencies,
  options: { testFirst: boolean }
): Promise<BatchKernelUpgradeRunResult> {
  const items: BatchKernelUpgradeItemResult[] = []
  let pauseReason: string | undefined
  let testCompleted = !options.testFirst

  for (const plan of plans) {
    const fromVersion = plan.profile.kernelVersion || undefined
    if (plan.skipReason) {
      items.push({
        profileId: plan.profile.id,
        name: plan.profile.name,
        status: 'skipped',
        fromVersion,
        reason: plan.skipReason
      })
      continue
    }

    if (pauseReason) {
      items.push({
        profileId: plan.profile.id,
        name: plan.profile.name,
        status: 'skipped',
        fromVersion,
        toVersion: plan.targetVersion,
        reason: pauseReason
      })
      continue
    }

    if (!plan.targetVersion || !plan.targetFamily) {
      items.push({
        profileId: plan.profile.id,
        name: plan.profile.name,
        status: 'skipped',
        fromVersion,
        reason: '没有可执行的升级目标'
      })
      continue
    }

    try {
      const upgraded = await dependencies.upgrade(plan.profile.id, plan.targetVersion, plan.targetFamily)
      dependencies.onProfileChanged?.(upgraded.profile)

      if (!testCompleted) {
        const diagnostic = await dependencies.diagnose(plan.profile.id)
        if (!diagnostic.ready) {
          const failure = diagnosticFailure(diagnostic)
          let rollbackNote = '已自动回滚升级前状态'
          try {
            const rolledBack = await dependencies.rollback(plan.profile.id)
            dependencies.onProfileChanged?.(rolledBack)
          } catch (rollbackError) {
            rollbackNote = `自动回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          }
          const reason = `首个测试环境诊断未通过：${failure}；${rollbackNote}`
          items.push({
            profileId: plan.profile.id,
            name: plan.profile.name,
            status: 'failed',
            fromVersion,
            toVersion: plan.targetVersion,
            reason
          })
          pauseReason = '前一个测试环境未通过，批量升级已暂停'
          continue
        }
        testCompleted = true
      }

      items.push({
        profileId: plan.profile.id,
        name: plan.profile.name,
        status: 'success',
        fromVersion,
        toVersion: plan.targetVersion,
        reason: testCompleted && options.testFirst && items.every((item) => item.status !== 'success')
          ? '首个测试环境升级并通过启动诊断'
          : '升级成功'
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      items.push({
        profileId: plan.profile.id,
        name: plan.profile.name,
        status: 'failed',
        fromVersion,
        toVersion: plan.targetVersion,
        reason
      })
      pauseReason = '前一个环境升级失败，批量升级已暂停'
    }
  }

  return { items, paused: Boolean(pauseReason) }
}
