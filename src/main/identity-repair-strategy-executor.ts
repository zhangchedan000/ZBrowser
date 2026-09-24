import type {
  BrowserProfile,
  FingerprintRepairExecutionSummary,
  FingerprintRepairPlan,
  FingerprintRuntimeDiagnosticReport,
  IdentityRepairStrategyExecutionSummary,
  ProxyCheckSummary,
  ProxyConfig,
  ProxyPoolEntry
} from '../shared/types'
import { normalizeIdentityConfigProvenance } from '../shared/identity-config-provenance'
import type { IdentityRepairStrategy } from '../shared/identity-repair-strategy'
import type { IdentityBaseline } from '../shared/identity-baseline-model'
import type { IdentityBaselineReplacementReason, IdentityBaselineReplacementRequest } from './identity-baseline-store'
import { IdentityBaselineStore } from './identity-baseline-store'
import type { AppLogger } from './app-logger'
import type { ProfileNetworkIdentityCheckpoint } from './profile-store'

interface IdentityRepairProfileStore {
  readonly vaultPath: string
  get(id: string): BrowserProfile
  assignProxy(id: string, input: ProxyConfig, check: ProxyCheckSummary, proxyPoolEntryId?: string): Promise<BrowserProfile>
  restoreNetworkIdentity(id: string, checkpoint: ProfileNetworkIdentityCheckpoint): Promise<BrowserProfile>
}

interface IdentityRepairRuntimeVerifier {
  diagnoseFingerprintRuntime(id: string): Promise<FingerprintRuntimeDiagnosticReport>
}

interface IdentityRepairProxyPool {
  test(id: string): Promise<ProxyPoolEntry>
  check(id: string): ProxyCheckSummary | undefined
  proxyConfig(id: string): ProxyConfig
}

interface FingerprintRepairRunner {
  plan(profileId: string): Promise<FingerprintRepairPlan>
  execute(
    profileId: string,
    approvedByUser: boolean,
    planId: string,
    requestedSections: FingerprintRepairPlan['sections']
  ): Promise<FingerprintRepairExecutionSummary & { profile: BrowserProfile }>
}

interface IdentityRepairStrategyExecutionResultInternal extends IdentityRepairStrategyExecutionSummary {
  profile: BrowserProfile
}

interface BaselineState {
  current: IdentityBaseline | null
  pending: IdentityBaselineReplacementRequest | null
}

function networkCheckpoint(profile: BrowserProfile): ProfileNetworkIdentityCheckpoint {
  return {
    proxy: { ...profile.proxy },
    proxyPoolEntryId: profile.proxyPoolEntryId,
    proxyCheck: profile.proxyCheck ? { ...profile.proxyCheck } : undefined,
    fingerprint: {
      ...profile.fingerprint,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
  }
}

function noStrategy(report: FingerprintRuntimeDiagnosticReport): IdentityRepairStrategy {
  return report.identityRepairStrategy ?? {
    kind: 'none',
    reason: '当前诊断没有可执行的 Identity Repair Strategy',
    affectedSections: [],
    requiresUserConfirmation: false,
    automaticActionAvailable: false
  }
}

export class IdentityRepairStrategyExecutor {
  constructor(
    private readonly profiles: IdentityRepairProfileStore,
    private readonly verifier: IdentityRepairRuntimeVerifier,
    private readonly proxyPool: IdentityRepairProxyPool,
    private readonly fingerprintRepair: FingerprintRepairRunner,
    private readonly logger?: AppLogger
  ) {}

  private async baselineState(profileId: string): Promise<BaselineState> {
    const store = new IdentityBaselineStore(this.profiles.vaultPath)
    const [current, pending] = await Promise.all([
      store.get(profileId),
      store.pendingReplacement(profileId)
    ])
    return { current, pending }
  }

  private async restoreBaselineState(profileId: string, before: BaselineState): Promise<void> {
    const store = new IdentityBaselineStore(this.profiles.vaultPath)
    await store.clearPendingReplacement(profileId)

    if (!before.current) return
    if (before.pending) {
      for (const reason of before.pending.reasons) {
        await store.requestReplacement(profileId, reason as IdentityBaselineReplacementReason)
      }
      return
    }
    if (before.current.status === 'stale') {
      await store.markStale(profileId)
      return
    }
    await store.markVerified(profileId)
  }

  private assertApproval(strategy: IdentityRepairStrategy, approvedByUser: boolean): void {
    if (strategy.requiresUserConfirmation && !approvedByUser) {
      throw new Error('该 Identity Repair Strategy 必须由用户明确确认后才能执行')
    }
  }

  private async executeProxySwitch(
    profileId: string,
    strategy: IdentityRepairStrategy,
    approvedByUser: boolean
  ): Promise<IdentityRepairStrategyExecutionResultInternal> {
    this.assertApproval(strategy, approvedByUser)
    const candidate = strategy.candidateProxy
    if (!candidate) throw new Error('当前没有符合 Identity Intent 的可用代理候选')

    const current = this.profiles.get(profileId)
    const checkpoint = networkCheckpoint(current)
    const baselineBefore = await this.baselineState(profileId)

    const refreshed = await this.proxyPool.test(candidate.id)
    const check = this.proxyPool.check(candidate.id)
    if (!check?.ok || refreshed.health === 'failed' || refreshed.health === 'quarantined' || refreshed.health === 'unchecked') {
      throw new Error('推荐代理重新检测后不可用，已取消自动切换')
    }
    const target = strategy.targetCountryCode?.toUpperCase()
    const observed = check.countryCode?.toUpperCase()
    if (target && observed !== target) {
      throw new Error(`推荐代理重新检测后出口国家为 ${observed ?? '未知'}，不再符合目标国家 ${target}`)
    }

    let assigned = false
    try {
      await this.profiles.assignProxy(profileId, this.proxyPool.proxyConfig(candidate.id), check, candidate.id)
      assigned = true
      const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
      if (report.ready && report.identityIntentConsistency?.status === 'aligned') {
        const profile = this.profiles.get(profileId)
        this.logger?.info('Identity Repair Strategy 已切换代理并通过 Runtime Verify', {
          profileId,
          proxyId: candidate.id,
          targetCountryCode: target,
          baselineVersion: report.identityBaseline?.version
        })
        return {
          status: 'completed',
          strategy,
          message: report.identityBaseline?.version
            ? `已切换到 ${candidate.name}，Runtime Verify 通过，Baseline 已更新到 v${report.identityBaseline.version}`
            : `已切换到 ${candidate.name} 并通过 Runtime Verify`,
          report,
          profile
        }
      }

      const restored = await this.profiles.restoreNetworkIdentity(profileId, checkpoint)
      await this.restoreBaselineState(profileId, baselineBefore)
      const restoredReport = await this.verifier.diagnoseFingerprintRuntime(profileId)
      this.logger?.error('Identity Repair Strategy 切换代理后验证失败，已回滚', {
        profileId,
        proxyId: candidate.id,
        targetCountryCode: target
      })
      return {
        status: 'rolled_back',
        strategy,
        message: '切换代理后的 Runtime Verify 未通过，已自动恢复原 Network Identity',
        report: restoredReport,
        profile: restored
      }
    } catch (error) {
      if (assigned) {
        try {
          await this.profiles.restoreNetworkIdentity(profileId, checkpoint)
          await this.restoreBaselineState(profileId, baselineBefore)
        } catch (rollbackError) {
          this.logger?.error('Identity Repair Strategy 失败且 Network Identity 回滚失败', {
            profileId,
            error,
            rollbackError
          })
          throw new Error('Identity Repair Strategy 执行失败，且 Network Identity 自动回滚未完成')
        }
      }
      throw error
    }
  }

  private async executeFingerprintStrategy(
    profileId: string,
    strategy: IdentityRepairStrategy,
    approvedByUser: boolean
  ): Promise<IdentityRepairStrategyExecutionResultInternal> {
    this.assertApproval(strategy, approvedByUser)
    const plan = await this.fingerprintRepair.plan(profileId)
    if (plan.status === 'blocked') throw new Error(plan.blockedReason ?? '当前 AI 修复计划不可执行')
    if (plan.status !== 'ready' || !plan.sections.length) {
      const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
      return {
        status: 'no_action',
        strategy: report.identityRepairStrategy ?? strategy,
        message: '当前策略没有生成可安全执行的配置修改',
        report,
        profile: this.profiles.get(profileId)
      }
    }

    const preferred = strategy.affectedSections.filter((section) => plan.sections.includes(section))
    const sections = preferred.length ? preferred : plan.sections
    const result = await this.fingerprintRepair.execute(profileId, true, plan.planId, sections)
    return {
      status: result.status,
      strategy,
      message: result.message,
      report: result.report,
      profile: result.profile
    }
  }

  private async executeBaselineReplacement(
    profileId: string,
    strategy: IdentityRepairStrategy
  ): Promise<IdentityRepairStrategyExecutionResultInternal> {
    const initial = await this.verifier.diagnoseFingerprintRuntime(profileId)
    const target = initial.identityIntentConsistency?.targetCountryCode
    const runtimeCountry = initial.identityIntentConsistency?.runtimeCountryCode
    if (!initial.ready || !initial.identitySnapshot) {
      throw new Error('Runtime Identity 尚未通过验证，不能换代 Baseline')
    }
    if (target && runtimeCountry !== target) {
      throw new Error('Runtime 国家尚未与 Identity Intent 对齐，不能换代 Baseline')
    }

    const profile = this.profiles.get(profileId)
    const baseline = await new IdentityBaselineStore(this.profiles.vaultPath).create(
      profileId,
      initial.identitySnapshot,
      normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
    )
    const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
    return {
      status: 'completed',
      strategy,
      message: `Runtime Verify 通过，Identity Baseline 已换代到 v${baseline.version}`,
      report,
      profile: this.profiles.get(profileId)
    }
  }

  async execute(profileId: string, approvedByUser: boolean): Promise<IdentityRepairStrategyExecutionResultInternal> {
    const current = this.profiles.get(profileId)
    if (current.status !== 'closed' && current.status !== 'error') {
      throw new Error('请先关闭浏览器环境再执行 Identity Repair Strategy')
    }

    const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
    const strategy = noStrategy(report)

    if (strategy.kind === 'none' || strategy.kind === 'manual_review') {
      return {
        status: 'no_action',
        strategy,
        message: strategy.reason,
        report,
        profile: this.profiles.get(profileId)
      }
    }
    if (!strategy.automaticActionAvailable) {
      return {
        status: 'no_action',
        strategy,
        message: `${strategy.reason}；当前没有可自动执行的资源`,
        report,
        profile: this.profiles.get(profileId)
      }
    }

    if (strategy.kind === 'switch_proxy') {
      return this.executeProxySwitch(profileId, strategy, approvedByUser)
    }
    if (strategy.kind === 'repair_configuration' || strategy.kind === 'regenerate_identity') {
      return this.executeFingerprintStrategy(profileId, strategy, approvedByUser)
    }
    if (strategy.kind === 'replace_baseline') {
      return this.executeBaselineReplacement(profileId, strategy)
    }

    return {
      status: 'no_action',
      strategy,
      message: strategy.reason,
      report,
      profile: this.profiles.get(profileId)
    }
  }
}
