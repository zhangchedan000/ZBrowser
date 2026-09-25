import type { AttentionPatrolIntervalMinutes, AutomationAttentionAuditResult, AutomationAttentionPatrolStatus } from '../shared/types'
import type { AppLogger } from './app-logger'
import type { SettingsStore } from './settings-store'

const VALID_INTERVALS: AttentionPatrolIntervalMinutes[] = [15, 30, 60, 180]

export class AttentionPatrolScheduler {
  private timer?: NodeJS.Timeout
  private running = false
  private nextRunAt?: string
  private lastStartedAt?: string
  private lastCompletedAt?: string
  private lastError?: string
  private lastResult?: AutomationAttentionPatrolStatus['lastResult']

  constructor(
    private readonly settings: SettingsStore,
    private readonly runAudit: () => Promise<AutomationAttentionAuditResult>,
    private readonly onChanged?: (status: AutomationAttentionPatrolStatus) => void,
    private readonly logger?: AppLogger
  ) {}

  status(): AutomationAttentionPatrolStatus {
    const settings = this.settings.get()
    return {
      enabled: settings.attentionPatrolEnabled,
      intervalMinutes: settings.attentionPatrolIntervalMinutes,
      running: this.running,
      nextRunAt: this.nextRunAt,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError,
      lastResult: this.lastResult
    }
  }

  start(): void {
    this.schedule()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined
    this.emit()
  }

  async configure(enabled: boolean, intervalMinutes: AttentionPatrolIntervalMinutes): Promise<AutomationAttentionPatrolStatus> {
    if (!VALID_INTERVALS.includes(intervalMinutes)) throw new Error('自动巡检周期无效')
    await this.settings.update({
      attentionPatrolEnabled: enabled,
      attentionPatrolIntervalMinutes: intervalMinutes
    })
    this.schedule()
    return this.status()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined

    const settings = this.settings.get()
    if (!settings.attentionPatrolEnabled) {
      this.emit()
      return
    }

    const delay = settings.attentionPatrolIntervalMinutes * 60_000
    this.nextRunAt = new Date(Date.now() + delay).toISOString()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextRunAt = undefined
      void this.execute()
    }, delay)
    this.timer.unref()
    this.emit()
  }

  private async execute(): Promise<void> {
    if (this.running) {
      this.schedule()
      return
    }

    this.running = true
    this.lastStartedAt = new Date().toISOString()
    this.lastError = undefined
    this.emit()

    try {
      const result = await this.runAudit()
      this.lastCompletedAt = new Date().toISOString()
      this.lastResult = {
        completed: result.completed,
        confirmationRequired: result.confirmationRequired,
        failed: result.failed,
        resolved: result.review.resolvedCount,
        remaining: result.review.remainingCount,
        newlyDetected: result.review.newCount
      }
      this.logger?.info('周期 AI 巡检完成', {
        completed: result.completed,
        confirmationRequired: result.confirmationRequired,
        failed: result.failed,
        resolved: result.review.resolvedCount,
        remaining: result.review.remainingCount,
        newlyDetected: result.review.newCount
      })
    } catch (error) {
      this.lastCompletedAt = new Date().toISOString()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.logger?.error('周期 AI 巡检失败', error)
    } finally {
      this.running = false
      this.schedule()
    }
  }

  private emit(): void {
    this.onChanged?.(this.status())
  }
}
