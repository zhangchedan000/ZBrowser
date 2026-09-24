import type {
  BrowserProfile,
  FingerprintRuntimeDiagnosticReport,
  IdentitySelfHealingDecision,
  IdentitySelfHealingSummary
} from '../shared/types'
import { evaluateProfileSelfHealingPolicy, identityRepairStrategySignature } from '../shared/identity-self-healing-policy'
import type { IdentityRepairStrategyExecutionSummary } from '../shared/types'
import type { Logger } from './app-logger'
import type { IdentitySelfHealingStateStore } from './identity-self-healing-state'

interface SelfHealingProfileStore {
  get(id: string): BrowserProfile
  list(): BrowserProfile[]
}

interface SelfHealingVerifier {
  diagnoseFingerprintRuntime(id: string): Promise<FingerprintRuntimeDiagnosticReport>
}

interface SelfHealingStrategyExecutor {
  execute(
    profileId: string,
    approvedByUser: boolean,
    approvedByPolicy?: boolean
  ): Promise<IdentityRepairStrategyExecutionSummary & { profile: BrowserProfile }>
}

export class IdentitySelfHealingManager {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly profiles: SelfHealingProfileStore,
    private readonly verifier: SelfHealingVerifier,
    private readonly executor: SelfHealingStrategyExecutor,
    private readonly state: IdentitySelfHealingStateStore,
    private readonly logger?: Logger
  ) {}

  private async summary(
    profileId: string,
    decision?: IdentitySelfHealingDecision,
    reason?: string
  ): Promise<IdentitySelfHealingSummary> {
    const profile = this.profiles.get(profileId)
    const snapshot = await this.state.snapshot(profileId)
    const mode = profile.identityIntent?.selfHealingMode ?? 'assisted'
    let resolvedDecision = decision
    let resolvedReason = reason
    if (!resolvedDecision || !resolvedReason) {
      if (snapshot.cooldownUntil) {
        resolvedDecision = snapshot.consecutiveFailures >= 2 ? 'blocked' : 'cooldown'
        resolvedReason = snapshot.consecutiveFailures >= 2
          ? '同一恢复策略连续失败，循环保护仍在生效'
          : 'Self-Healing 处于冷却期'
      } else if (snapshot.pending?.policyAction === 'execute') {
        resolvedDecision = 'auto_execute'
        resolvedReason = '已检测到可由 Auto Policy 执行的低风险恢复任务'
      } else if (snapshot.pending) {
        resolvedDecision = mode === 'manual' ? 'disabled' : 'suggest'
        resolvedReason = snapshot.pending.reason
      } else {
        resolvedDecision = mode === 'manual' ? 'disabled' : 'suggest'
        resolvedReason = mode === 'manual'
          ? 'Self-Healing 为 Manual，仅监控身份状态'
          : '当前没有待处理的 Self-Healing 任务'
      }
    }
    return {
      mode,
      decision: resolvedDecision ?? 'disabled',
      reason: resolvedReason ?? 'Self-Healing 状态尚未初始化',
      pending: Boolean(snapshot.pending),
      attemptsInWindow: snapshot.attemptsInWindow,
      consecutiveFailures: snapshot.consecutiveFailures,
      cooldownUntil: snapshot.cooldownUntil,
      lastAttemptAt: snapshot.lastAttemptAt,
      lastResult: snapshot.lastResult,
      lastAttemptTrigger: snapshot.lastAttemptTrigger,
      lastStrategyKind: snapshot.lastStrategyKind,
      lastMessage: snapshot.lastMessage,
      pendingStrategyKind: snapshot.pending?.strategyKind,
      pendingReason: snapshot.pending?.reason,
      pendingDetectedAt: snapshot.pending?.detectedAt
    }
  }

  async status(profileId: string): Promise<IdentitySelfHealingSummary> {
    this.profiles.get(profileId)
    return this.summary(profileId)
  }

  async statusAll(): Promise<Record<string, IdentitySelfHealingSummary>> {
    const entries = await Promise.all(this.profiles.list().map(async (profile) => [
      profile.id,
      await this.summary(profile.id)
    ] as const))
    return Object.fromEntries(entries)
  }

  private async attach(
    report: FingerprintRuntimeDiagnosticReport,
    decision: IdentitySelfHealingDecision,
    reason: string
  ): Promise<FingerprintRuntimeDiagnosticReport> {
    return {
      ...report,
      identitySelfHealing: await this.summary(report.profileId, decision, reason)
    }
  }

  private async observe(profileId: string, report: FingerprintRuntimeDiagnosticReport): Promise<void> {
    const strategy = report.identityRepairStrategy
    if (!strategy) return
    if (strategy.kind === 'none') {
      await this.state.clearPending(profileId)
      return
    }
    const policy = evaluateProfileSelfHealingPolicy(this.profiles.get(profileId), report)
    await this.state.observe(profileId, {
      signature: identityRepairStrategySignature(strategy),
      strategyKind: strategy.kind,
      reason: strategy.reason,
      policyAction: policy.action,
      detectedAt: report.checkedAt
    })
  }

  async observeRuntimeReport(profileId: string, report: FingerprintRuntimeDiagnosticReport): Promise<void> {
    await this.observe(profileId, report)
  }

  private decisionName(action: 'none' | 'suggest' | 'execute'): IdentitySelfHealingDecision {
    if (action === 'execute') return 'auto_execute'
    if (action === 'suggest') return 'suggest'
    return 'disabled'
  }

  private async handleReport(
    profileId: string,
    report: FingerprintRuntimeDiagnosticReport
  ): Promise<FingerprintRuntimeDiagnosticReport> {
    const profile = this.profiles.get(profileId)
    const policy = evaluateProfileSelfHealingPolicy(profile, report)
    const strategy = report.identityRepairStrategy

    await this.observe(profileId, report)
    if (!strategy || strategy.kind === 'none' || policy.action !== 'execute') {
      return this.attach(report, this.decisionName(policy.action), policy.reason)
    }

    const signature = identityRepairStrategySignature(strategy)
    const guard = await this.state.guard(profileId, signature)
    if (!guard.allowed) {
      const decision: IdentitySelfHealingDecision = guard.reason?.includes('冷却') ? 'cooldown' : 'blocked'
      return this.attach(report, decision, guard.reason ?? 'Auto Self-Healing 暂时不可执行')
    }

    if (this.inFlight.has(profileId)) {
      return this.attach(report, 'blocked', '该环境已有 Self-Healing 执行中，已阻止并发重复修复')
    }

    this.inFlight.add(profileId)
    const attempt = await this.state.beginAttempt(profileId, signature, strategy.kind)
    try {
      const result = await this.executor.execute(profileId, false, true)
      await this.state.finishAttempt(profileId, attempt.id, result.status, result.message)
      if (result.status === 'no_action') await this.observe(profileId, result.report)
      const freshPolicy = evaluateProfileSelfHealingPolicy(this.profiles.get(profileId), result.report)
      const reason = result.status === 'completed'
        ? 'Auto Self-Healing 已完成并通过执行链验证'
        : result.status === 'rolled_back'
          ? 'Auto Self-Healing 验证失败，已自动回滚并进入保护状态'
          : result.message
      this.logger?.info('Auto Self-Healing 执行结束', {
        profileId,
        strategy: strategy.kind,
        status: result.status
      })
      return this.attach(
        result.report,
        result.status === 'rolled_back'
          ? 'cooldown'
          : result.status === 'no_action'
            ? this.decisionName(freshPolicy.action)
            : 'auto_execute',
        reason
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.state.finishAttempt(profileId, attempt.id, 'failed', message)
      this.logger?.error('Auto Self-Healing 执行失败', { profileId, strategy: strategy.kind, error: message })
      return this.attach(report, 'blocked', 'Auto Self-Healing 执行失败：' + message)
    } finally {
      this.inFlight.delete(profileId)
    }
  }

  async diagnose(profileId: string): Promise<FingerprintRuntimeDiagnosticReport> {
    return this.handleReport(profileId, await this.verifier.diagnoseFingerprintRuntime(profileId))
  }

  async executeApproved(profileId: string): Promise<IdentityRepairStrategyExecutionSummary & { profile: BrowserProfile }> {
    if (this.inFlight.has(profileId)) throw new Error('该环境已有 Self-Healing 执行中，请稍后重试')
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') {
      throw new Error('请先关闭浏览器环境再执行 Identity Repair Strategy')
    }

    let pending = await this.state.pending(profileId)
    if (!pending) {
      const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
      await this.observe(profileId, report)
      pending = await this.state.pending(profileId)
      if (!pending) {
        const result = await this.executor.execute(profileId, true)
        return {
          ...result,
          report: {
            ...result.report,
            identitySelfHealing: await this.summary(profileId)
          }
        }
      }
    }

    this.inFlight.add(profileId)
    const attempt = await this.state.beginAttempt(
      profileId,
      pending.signature,
      pending.strategyKind,
      new Date(),
      'user'
    )
    try {
      const result = await this.executor.execute(profileId, true)
      await this.state.finishAttempt(profileId, attempt.id, result.status, result.message)
      if (result.status === 'no_action') await this.observe(profileId, result.report)
      this.logger?.info('用户确认 Self-Healing 执行结束', {
        profileId,
        strategy: result.strategy.kind,
        status: result.status
      })
      return {
        ...result,
        report: {
          ...result.report,
          identitySelfHealing: await this.summary(profileId)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.state.finishAttempt(profileId, attempt.id, 'failed', message)
      this.logger?.error('用户确认 Self-Healing 执行失败', {
        profileId,
        strategy: pending.strategyKind,
        error: message
      })
      throw error
    } finally {
      this.inFlight.delete(profileId)
    }
  }

  async runPending(profileId: string): Promise<void> {
    if (this.inFlight.has(profileId)) return
    const profile = this.profiles.get(profileId)
    if ((profile.identityIntent?.selfHealingMode ?? 'assisted') !== 'auto') return
    if (profile.status !== 'closed' && profile.status !== 'error') return
    if (!await this.state.pending(profileId)) return
    await this.handleReport(profileId, await this.verifier.diagnoseFingerprintRuntime(profileId))
  }

  async resumePersistedPending(): Promise<number> {
    let resumed = 0
    for (const profile of this.profiles.list()) {
      if ((profile.identityIntent?.selfHealingMode ?? 'assisted') !== 'auto') continue
      if (profile.status !== 'closed' && profile.status !== 'error') continue
      if (!await this.state.pending(profile.id)) continue
      resumed += 1
      try {
        await this.runPending(profile.id)
      } catch (error) {
        this.logger?.error('启动时恢复 pending Self-Healing 失败', {
          profileId: profile.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return resumed
  }
}
