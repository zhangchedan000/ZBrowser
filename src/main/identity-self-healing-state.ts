import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IdentityRepairStrategyKind } from '../shared/identity-repair-strategy'
import type { IdentitySelfHealingPolicyAction } from '../shared/identity-self-healing-policy'
import type { IdentitySelfHealingAttemptRecord, IdentitySelfHealingAttemptResult, IdentitySelfHealingAttemptTrigger } from '../shared/types'

export const IDENTITY_SELF_HEALING_COOLDOWN_MS = 10 * 60_000
export const IDENTITY_SELF_HEALING_WINDOW_MS = 60 * 60_000
export const IDENTITY_SELF_HEALING_MAX_ATTEMPTS_PER_WINDOW = 3
export const IDENTITY_SELF_HEALING_LOOP_GUARD_FAILURES = 2
export const IDENTITY_SELF_HEALING_LOOP_BLOCK_MS = 60 * 60_000

export interface IdentitySelfHealingPending {
  detectedAt: string
  signature: string
  strategyKind: IdentityRepairStrategyKind
  reason: string
  policyAction?: IdentitySelfHealingPolicyAction
}

export interface IdentitySelfHealingAttempt {
  id: string
  startedAt: string
  completedAt?: string
  signature: string
  strategyKind: IdentityRepairStrategyKind
  trigger: IdentitySelfHealingAttemptTrigger
  result?: IdentitySelfHealingAttemptResult
  message?: string
}

interface IdentitySelfHealingFile {
  schemaVersion: 1
  pending?: IdentitySelfHealingPending
  attempts: IdentitySelfHealingAttempt[]
  consecutiveFailures: number
  lastFailureSignature?: string
  blockedUntil?: string
}

export interface IdentitySelfHealingGuard {
  allowed: boolean
  reason?: string
  cooldownUntil?: string
  attemptsInWindow: number
  consecutiveFailures: number
}

export interface IdentitySelfHealingStateSnapshot {
  pending?: IdentitySelfHealingPending
  attemptsInWindow: number
  consecutiveFailures: number
  cooldownUntil?: string
  lastAttemptAt?: string
  lastResult?: IdentitySelfHealingAttemptResult
  lastAttemptTrigger?: IdentitySelfHealingAttemptTrigger
  lastStrategyKind?: IdentityRepairStrategyKind
  lastMessage?: string
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validKind(value: unknown): value is IdentityRepairStrategyKind {
  return value === 'none'
    || value === 'switch_proxy'
    || value === 'regenerate_identity'
    || value === 'repair_configuration'
    || value === 'replace_baseline'
    || value === 'manual_review'
}

function validResult(value: unknown): value is IdentitySelfHealingAttemptResult {
  return value === 'completed' || value === 'rolled_back' || value === 'failed' || value === 'no_action'
}

function safeFile(value: unknown): IdentitySelfHealingFile {
  if (!value || typeof value !== 'object') {
    return { schemaVersion: 1, attempts: [], consecutiveFailures: 0 }
  }
  const raw = value as Partial<IdentitySelfHealingFile>
  const attempts = Array.isArray(raw.attempts)
    ? raw.attempts.filter((item): item is IdentitySelfHealingAttempt => Boolean(
        item
        && typeof item === 'object'
        && typeof item.id === 'string'
        && validDate(item.startedAt)
        && typeof item.signature === 'string'
        && validKind(item.strategyKind)
      )).map((item) => ({
        ...item,
        trigger: (item.trigger === 'user' ? 'user' : 'auto') as IdentitySelfHealingAttemptTrigger,
        completedAt: validDate(item.completedAt) ? item.completedAt : undefined,
        result: validResult(item.result) ? item.result : undefined,
        message: typeof item.message === 'string' ? item.message.slice(0, 500) : undefined
      })).slice(-20)
    : []

  const pending = raw.pending
    && typeof raw.pending === 'object'
    && validDate(raw.pending.detectedAt)
    && typeof raw.pending.signature === 'string'
    && validKind(raw.pending.strategyKind)
    && typeof raw.pending.reason === 'string'
    ? {
        detectedAt: raw.pending.detectedAt,
        signature: raw.pending.signature,
        strategyKind: raw.pending.strategyKind,
        reason: raw.pending.reason.slice(0, 500),
        policyAction: raw.pending.policyAction === 'none' || raw.pending.policyAction === 'suggest' || raw.pending.policyAction === 'execute'
          ? raw.pending.policyAction
          : undefined
      }
    : undefined

  return {
    schemaVersion: 1,
    attempts,
    pending,
    consecutiveFailures: Number.isInteger(raw.consecutiveFailures) && Number(raw.consecutiveFailures) >= 0
      ? Number(raw.consecutiveFailures)
      : 0,
    lastFailureSignature: typeof raw.lastFailureSignature === 'string' ? raw.lastFailureSignature : undefined,
    blockedUntil: validDate(raw.blockedUntil) ? raw.blockedUntil : undefined
  }
}

export class IdentitySelfHealingStateStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly rootPath: string) {}

  private path(profileId: string): string {
    return join(this.rootPath, profileId, 'identity-self-healing.json')
  }

  private async read(profileId: string): Promise<IdentitySelfHealingFile> {
    await this.writeQueue.catch(() => undefined)
    try {
      return safeFile(JSON.parse(await readFile(this.path(profileId), 'utf8')))
    } catch {
      return { schemaVersion: 1, attempts: [], consecutiveFailures: 0 }
    }
  }

  private async write(profileId: string, data: IdentitySelfHealingFile): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(join(this.rootPath, profileId), { recursive: true })
      const target = this.path(profileId)
      const temporary = target + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify({ ...data, schemaVersion: 1 }, null, 2), 'utf8')
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    }
    this.writeQueue = this.writeQueue.then(operation, operation)
    await this.writeQueue
  }

  async observe(
    profileId: string,
    pending: Omit<IdentitySelfHealingPending, 'detectedAt'> & { detectedAt?: string }
  ): Promise<void> {
    const data = await this.read(profileId)
    data.pending = {
      ...pending,
      detectedAt: pending.detectedAt ?? new Date().toISOString()
    }
    await this.write(profileId, data)
  }

  async clearPending(profileId: string): Promise<void> {
    const data = await this.read(profileId)
    if (!data.pending) return
    data.pending = undefined
    await this.write(profileId, data)
  }

  async pending(profileId: string): Promise<IdentitySelfHealingPending | null> {
    return (await this.read(profileId)).pending ?? null
  }

  async guard(profileId: string, signature: string, nowMs = Date.now()): Promise<IdentitySelfHealingGuard> {
    const data = await this.read(profileId)
    const recent = data.attempts.filter((attempt) => nowMs - Date.parse(attempt.startedAt) < IDENTITY_SELF_HEALING_WINDOW_MS)
    const last = data.attempts.at(-1)

    if (data.blockedUntil && Date.parse(data.blockedUntil) > nowMs) {
      return {
        allowed: false,
        reason: '同一恢复策略连续失败，已触发循环保护',
        cooldownUntil: data.blockedUntil,
        attemptsInWindow: recent.length,
        consecutiveFailures: data.consecutiveFailures
      }
    }

    if (last) {
      const cooldownUntilMs = Date.parse(last.startedAt) + IDENTITY_SELF_HEALING_COOLDOWN_MS
      if (cooldownUntilMs > nowMs) {
        return {
          allowed: false,
          reason: 'Self-Healing 处于冷却期，避免短时间重复修改身份',
          cooldownUntil: new Date(cooldownUntilMs).toISOString(),
          attemptsInWindow: recent.length,
          consecutiveFailures: data.consecutiveFailures
        }
      }
    }

    if (recent.length >= IDENTITY_SELF_HEALING_MAX_ATTEMPTS_PER_WINDOW) {
      const oldest = recent[0]
      const until = new Date(Date.parse(oldest.startedAt) + IDENTITY_SELF_HEALING_WINDOW_MS).toISOString()
      return {
        allowed: false,
        reason: '一小时内自动修复次数已达上限',
        cooldownUntil: until,
        attemptsInWindow: recent.length,
        consecutiveFailures: data.consecutiveFailures
      }
    }

    if (
      data.consecutiveFailures >= IDENTITY_SELF_HEALING_LOOP_GUARD_FAILURES
      && data.lastFailureSignature === signature
    ) {
      const blockedUntil = last
        ? new Date(Date.parse(last.startedAt) + IDENTITY_SELF_HEALING_LOOP_BLOCK_MS).toISOString()
        : new Date(nowMs + IDENTITY_SELF_HEALING_LOOP_BLOCK_MS).toISOString()
      return {
        allowed: false,
        reason: '同一恢复策略连续失败，已触发循环保护',
        cooldownUntil: blockedUntil,
        attemptsInWindow: recent.length,
        consecutiveFailures: data.consecutiveFailures
      }
    }

    return {
      allowed: true,
      attemptsInWindow: recent.length,
      consecutiveFailures: data.consecutiveFailures
    }
  }

  async beginAttempt(
    profileId: string,
    signature: string,
    strategyKind: IdentityRepairStrategyKind,
    now = new Date(),
    trigger: IdentitySelfHealingAttemptTrigger = 'auto'
  ): Promise<IdentitySelfHealingAttempt> {
    const data = await this.read(profileId)
    const attempt: IdentitySelfHealingAttempt = {
      id: randomUUID(),
      startedAt: now.toISOString(),
      signature,
      strategyKind,
      trigger
    }
    data.attempts = [...data.attempts, attempt].slice(-20)
    await this.write(profileId, data)
    return attempt
  }

  async finishAttempt(
    profileId: string,
    attemptId: string,
    result: IdentitySelfHealingAttemptResult,
    message: string,
    now = new Date()
  ): Promise<void> {
    const data = await this.read(profileId)
    const index = data.attempts.findIndex((attempt) => attempt.id === attemptId)
    if (index < 0) return

    const attempt = data.attempts[index]
    data.attempts[index] = {
      ...attempt,
      completedAt: now.toISOString(),
      result,
      message: message.slice(0, 500)
    }

    if (result === 'rolled_back' || result === 'failed') {
      if (data.lastFailureSignature === attempt.signature) data.consecutiveFailures += 1
      else data.consecutiveFailures = 1
      data.lastFailureSignature = attempt.signature
      if (data.consecutiveFailures >= IDENTITY_SELF_HEALING_LOOP_GUARD_FAILURES) {
        data.blockedUntil = new Date(now.getTime() + IDENTITY_SELF_HEALING_LOOP_BLOCK_MS).toISOString()
      }
    } else {
      data.consecutiveFailures = 0
      data.lastFailureSignature = undefined
      data.blockedUntil = undefined
    }

    if (result === 'completed' || result === 'no_action') data.pending = undefined
    await this.write(profileId, data)
  }

  async history(profileId: string): Promise<IdentitySelfHealingAttemptRecord[]> {
    const data = await this.read(profileId)
    return [...data.attempts]
      .reverse()
      .map((attempt) => ({
        id: attempt.id,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        signature: attempt.signature,
        strategyKind: attempt.strategyKind,
        trigger: attempt.trigger,
        result: attempt.result,
        message: attempt.message
      }))
  }

  async snapshot(profileId: string, nowMs = Date.now()): Promise<IdentitySelfHealingStateSnapshot> {
    const data = await this.read(profileId)
    const attemptsInWindow = data.attempts.filter((attempt) =>
      nowMs - Date.parse(attempt.startedAt) < IDENTITY_SELF_HEALING_WINDOW_MS
    ).length
    const last = data.attempts.at(-1)
    let cooldownUntil = data.blockedUntil && Date.parse(data.blockedUntil) > nowMs ? data.blockedUntil : undefined
    if (!cooldownUntil && last) {
      const cooldown = Date.parse(last.startedAt) + IDENTITY_SELF_HEALING_COOLDOWN_MS
      if (cooldown > nowMs) cooldownUntil = new Date(cooldown).toISOString()
    }
    return {
      pending: data.pending,
      attemptsInWindow,
      consecutiveFailures: data.consecutiveFailures,
      cooldownUntil,
      lastAttemptAt: last?.startedAt,
      lastResult: last?.result,
      lastAttemptTrigger: last?.trigger,
      lastStrategyKind: last?.strategyKind,
      lastMessage: last?.message
    }
  }
}
