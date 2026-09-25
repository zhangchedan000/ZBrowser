import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AttentionAuditResultStatus,
  AttentionAuditSummary,
  AttentionAuditStepResult
} from './attention-audit'
import type { AttentionPlanAction, AttentionPlanRisk } from '../shared/profile-attention-plan'

const MAX_RECORDS = 50

export interface AttentionAuditHistoryStep {
  priority: number
  profileId: string
  action: AttentionPlanAction
  risk: AttentionPlanRisk
  status: AttentionAuditResultStatus
  startedAt?: string
  completedAt?: string
  message: string
}

export interface AttentionAuditHistoryRecord {
  id: string
  startedAt: string
  completedAt: string
  total: number
  completed: number
  confirmationRequired: number
  failed: number
  results: AttentionAuditHistoryStep[]
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validAction(value: unknown): value is AttentionPlanAction {
  return value === 'inspect_process'
    || value === 'run_identity_check'
    || value === 'review_self_healing'
    || value === 'confirm_self_healing'
}

function validRisk(value: unknown): value is AttentionPlanRisk {
  return value === 'read_only'
    || value === 'policy_gated'
    || value === 'confirmation_required'
}

function validStatus(value: unknown): value is AttentionAuditResultStatus {
  return value === 'completed'
    || value === 'confirmation_required'
    || value === 'failed'
}

function safeStep(value: unknown): AttentionAuditHistoryStep | null {
  if (!value || typeof value !== 'object') return null
  const step = value as Partial<AttentionAuditStepResult>
  if (
    !Number.isInteger(step.priority)
    || Number(step.priority) <= 0
    || typeof step.profileId !== 'string'
    || !step.profileId
    || !validAction(step.action)
    || !validRisk(step.risk)
    || !validStatus(step.status)
    || typeof step.message !== 'string'
  ) return null

  return {
    priority: Number(step.priority),
    profileId: step.profileId.slice(0, 120),
    action: step.action,
    risk: step.risk,
    status: step.status,
    startedAt: validDate(step.startedAt) ? step.startedAt : undefined,
    completedAt: validDate(step.completedAt) ? step.completedAt : undefined,
    message: step.message.slice(0, 500)
  }
}

function safeRecord(value: unknown): AttentionAuditHistoryRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<AttentionAuditHistoryRecord>
  const results = Array.isArray(record.results)
    ? record.results.map(safeStep).filter((step): step is AttentionAuditHistoryStep => step !== null)
    : []

  if (
    typeof record.id !== 'string'
    || !record.id
    || !validDate(record.startedAt)
    || !validDate(record.completedAt)
    || !Number.isInteger(record.total)
    || !Number.isInteger(record.completed)
    || !Number.isInteger(record.confirmationRequired)
    || !Number.isInteger(record.failed)
  ) return null

  return {
    id: record.id.slice(0, 120),
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    total: Math.max(0, Number(record.total)),
    completed: Math.max(0, Number(record.completed)),
    confirmationRequired: Math.max(0, Number(record.confirmationRequired)),
    failed: Math.max(0, Number(record.failed)),
    results
  }
}

export class AttentionAuditHistoryStore {
  private readonly path: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(vaultPath: string) {
    this.path = join(vaultPath, 'attention-audit-history.json')
  }

  private async read(): Promise<AttentionAuditHistoryRecord[]> {
    await this.writeQueue.catch(() => undefined)
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(safeRecord)
        .filter((record): record is AttentionAuditHistoryRecord => record !== null)
        .slice(-MAX_RECORDS)
    } catch {
      return []
    }
  }

  async list(): Promise<AttentionAuditHistoryRecord[]> {
    return [...await this.read()].reverse()
  }

  async record(summary: AttentionAuditSummary): Promise<AttentionAuditHistoryRecord> {
    const record: AttentionAuditHistoryRecord = {
      id: randomUUID(),
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      total: summary.total,
      completed: summary.completed,
      confirmationRequired: summary.confirmationRequired,
      failed: summary.failed,
      results: summary.results.map((step) => ({
        priority: step.priority,
        profileId: step.profileId,
        action: step.action,
        risk: step.risk,
        status: step.status,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        message: step.message.slice(0, 500)
      }))
    }

    const operation = async (): Promise<void> => {
      const existing = await this.read()
      const next = [...existing, record].slice(-MAX_RECORDS)
      await mkdir(join(this.path, '..'), { recursive: true })
      const temporary = this.path + '.tmp'
      await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.path)
    }

    this.writeQueue = this.writeQueue.then(operation, operation)
    await this.writeQueue
    return record
  }
}
