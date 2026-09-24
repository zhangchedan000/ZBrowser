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
    decision: IdentitySelfHealingDecision,
    reason: string
  ): Promise<IdentitySelfHealingSummary> {
    const profile = this.profiles.get(profileId)
    const snapshot = await this.state.snapshot(profileId)
    return {
      mode: profile.identityIntent?.selfHealingMode ?? 'assisted',
      decision,
      reason,
      pending: Boolean(snapshot.pending),
      attemptsInWindow: snapshot.attemptsInWindow,
      consecutiveFailures: snapshot.consecutiveFailures,
      cooldownUntil: snapshot.cooldownUntil,
      lastAttemptAt: snapshot.lastAttemptAt,
      lastResult: snapshot.lastResult,
      lastStrategyKind: snapshot.lastStrategyKind,
      lastMessage: snapshot.lastMessage
    }
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
    await this.state.observe(profileId, {
      signature: identityRepairStrategySignature(strategy),
      strategyKind: strategy.kind,
      reason: strategy.reason,
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

  async runPending(profileId: string): Promise<void> {
    if (this.inFlight.has(profileId)) return
    const profile = this.profiles.get(profileId)
    if ((profile.identityIntent?.selfHealingMode ?? 'assisted') !== 'auto') return
    if (profile.status !== 'closed' && profile.status !== 'error') return
    if (!await this.state.pending(profileId)) return
    await this.handleReport(profileId, await this.verifier.diagnoseFingerprintRuntime(profileId))
  }
}
