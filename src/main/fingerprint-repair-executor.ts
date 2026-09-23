import { randomUUID } from 'node:crypto'
import type {
  BrowserProfile,
  FingerprintRepairAuditPhase,
  FingerprintRepairChange,
  FingerprintRepairExecutionSummary,
  FingerprintRepairPlan,
  FingerprintRuntimeDiagnosticReport,
  IdentityConfigSection,
  ProfileDraft
} from '../shared/types'
import {
  applyAIIdentityConfigToFingerprint,
  generateAIIdentityConfig,
  type AIIdentityGenerationRequest,
  type AIIdentityGenerationResult
} from '../shared/identity-ai-generator'
import {
  HARDWARE_IDENTITY_FIELDS,
  identityConfigSource,
  identitySectionForFingerprintField,
  markIdentityConfigFields,
  normalizeIdentityConfigProvenance
} from '../shared/identity-config-provenance'
import { diagnosticConfigTarget } from '../shared/fingerprint-health-adapter'
import {
  approveRepairWorkflow,
  createRepairWorkflow,
  validateRepairSafety,
  type RepairAction
} from '../shared/fingerprint-repair-workflow'
import type { Logger } from './app-logger'
import type { ProfileStore } from './profile-store'
import type { FingerprintRepairStateStore } from './fingerprint-repair-state'

interface FingerprintRuntimeVerifier {
  diagnoseFingerprintRuntime(id: string): Promise<FingerprintRuntimeDiagnosticReport>
}

type IdentityGenerator = (request: AIIdentityGenerationRequest) => AIIdentityGenerationResult

interface FingerprintRepairExecutionResultInternal extends FingerprintRepairExecutionSummary {
  profile: BrowserProfile
}

interface PendingRepairPlan {
  publicPlan: FingerprintRepairPlan
  nextFingerprint: BrowserProfile['fingerprint']
}

const PLAN_TTL_MS = 10 * 60 * 1000
const VALID_SECTIONS = new Set<IdentityConfigSection>(['fingerprint', 'network', 'locale', 'browser'])

function profileDraft(profile: BrowserProfile): ProfileDraft {
  return {
    name: profile.name,
    note: profile.note,
    group: profile.group,
    tags: [...profile.tags],
    extensionIds: [...profile.extensionIds],
    color: profile.color,
    startUrls: [...profile.startUrls],
    kernelVersion: profile.kernelVersion,
    kernelFamily: profile.kernelFamily,
    environmentType: profile.environmentType,
    identityConfigProvenance: normalizeIdentityConfigProvenance(profile.identityConfigProvenance),
    window: { ...profile.window },
    proxy: { ...profile.proxy },
    fingerprint: {
      ...profile.fingerprint,
      disabledSpoofing: [...profile.fingerprint.disabledSpoofing]
    }
  }
}

function fingerprintRecord(value: BrowserProfile['fingerprint']): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}

function changedFingerprintFields(before: BrowserProfile['fingerprint'], after: BrowserProfile['fingerprint']): string[] {
  const beforeRecord = fingerprintRecord(before)
  const afterRecord = fingerprintRecord(after)
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])
  return [...keys].filter((key) => JSON.stringify(beforeRecord[key]) !== JSON.stringify(afterRecord[key])).sort()
}

function repairChanges(profile: BrowserProfile, nextFingerprint: BrowserProfile['fingerprint']): FingerprintRepairChange[] {
  const provenance = normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
  const before = fingerprintRecord(profile.fingerprint)
  const after = fingerprintRecord(nextFingerprint)
  return changedFingerprintFields(profile.fingerprint, nextFingerprint).map((field) => {
    const section = identitySectionForFingerprintField(field)
    return {
      section,
      field,
      source: identityConfigSource(provenance, section, field),
      before: before[field],
      after: after[field]
    }
  })
}

function componentForSection(section: IdentityConfigSection): RepairAction['component'] {
  if (section === 'network') return 'network'
  if (section === 'locale') return 'locale'
  if (section === 'browser') return 'browser'
  return 'hardware'
}

function repairActions(profile: BrowserProfile, changes: FingerprintRepairChange[]): RepairAction[] {
  const provenance = normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
  const grouped = new Map<IdentityConfigSection, string[]>()
  for (const change of changes) {
    grouped.set(change.section, [...(grouped.get(change.section) ?? []), change.field])
  }
  return [...grouped.entries()].map(([section, keys]) => ({
    id: `identity-${section}`,
    component: componentForSection(section),
    description: `Apply AI repair to ${section}: ${keys.join(', ')}`,
    requiresBackup: true,
    reversible: true,
    mutatesConfiguration: true,
    configSources: [...new Set(keys.map((key) => identityConfigSource(provenance, section, key)))]
  }))
}

function assertNoUserOverrideChanged(profile: BrowserProfile, changes: FingerprintRepairChange[]): void {
  const provenance = normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
  for (const change of changes) {
    if (identityConfigSource(provenance, change.section, change.field) === 'user') {
      throw new Error(`AI 修复被手动配置保护阻止：${change.section}.${change.field}`)
    }
  }
}

function applySelectedChanges(
  current: BrowserProfile['fingerprint'],
  planned: BrowserProfile['fingerprint'],
  changes: FingerprintRepairChange[]
): BrowserProfile['fingerprint'] {
  const next: BrowserProfile['fingerprint'] = {
    ...current,
    disabledSpoofing: [...current.disabledSpoofing]
  }
  const target = fingerprintRecord(next)
  const source = fingerprintRecord(planned)
  for (const change of changes) {
    if (source[change.field] === undefined) delete target[change.field]
    else target[change.field] = source[change.field]
  }
  if (Array.isArray(next.disabledSpoofing)) next.disabledSpoofing = [...next.disabledSpoofing]
  return next
}

function selectedProvenance(profile: BrowserProfile, changes: FingerprintRepairChange[]) {
  let provenance = normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
  for (const change of changes) {
    provenance = markIdentityConfigFields(provenance, change.section, [change.field], 'ai', true)
  }
  return provenance
}

function scopedRuntimeVerify(
  report: FingerprintRuntimeDiagnosticReport,
  selectedSections: IdentityConfigSection[]
): boolean {
  if (report.ready) return true
  if (!report.snapshot) return false
  const selected = new Set(selectedSections)
  return !report.checks.some((check) => {
    if (check.status !== 'error') return false
    const target = diagnosticConfigTarget(check.key)
    if (!target) return true
    return selected.has(target.section)
  })
}

export class FingerprintRepairExecutor {
  private readonly pendingPlans = new Map<string, PendingRepairPlan>()

  constructor(
    private readonly profiles: ProfileStore,
    private readonly verifier: FingerprintRuntimeVerifier,
    private readonly state: FingerprintRepairStateStore,
    private readonly logger?: Logger,
    private readonly generateIdentity: IdentityGenerator = generateAIIdentityConfig
  ) {}

  private prunePlans(): void {
    const now = Date.now()
    for (const [id, plan] of this.pendingPlans.entries()) {
      if (Date.parse(plan.publicPlan.expiresAt) <= now) this.pendingPlans.delete(id)
    }
  }

  private identityRequest(profile: BrowserProfile): AIIdentityGenerationRequest {
    return {
      baseFingerprint: profile.fingerprint,
      platform: profile.fingerprint.platform,
      proxyProtocol: profile.proxy.protocol,
      proxyCheck: profile.proxyCheck,
      countryCode: profile.proxyCheck?.countryCode,
      networkMode: profile.proxy.protocol === 'direct' ? 'manual' : 'proxy'
    }
  }

  async plan(profileId: string): Promise<FingerprintRepairPlan> {
    this.prunePlans()
    const current = this.profiles.get(profileId)
    const generatedAt = new Date()
    const expiresAt = new Date(generatedAt.getTime() + PLAN_TTL_MS)
    const base = {
      planId: randomUUID(),
      profileId,
      profileUpdatedAt: current.updatedAt,
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    }

    if (current.status !== 'closed' && current.status !== 'error') {
      return {
        ...base,
        status: 'blocked',
        sections: [],
        changes: [],
        warnings: [],
        blockedReason: '请先关闭浏览器环境再生成 AI 修复计划'
      }
    }

    const generated = this.generateIdentity(this.identityRequest(current))
    const nextFingerprint = applyAIIdentityConfigToFingerprint(
      current.fingerprint,
      generated,
      current.identityConfigProvenance
    )
    const changes = repairChanges(current, nextFingerprint)

    if (!changes.length) {
      return {
        ...base,
        status: 'no_changes',
        sections: [],
        changes: [],
        warnings: generated.warnings
      }
    }

    const hardwareChanges = changes.filter((change) =>
      HARDWARE_IDENTITY_FIELDS.includes(change.field as (typeof HARDWARE_IDENTITY_FIELDS)[number])
    )
    if (hardwareChanges.length && !generated.personaId && current.fingerprint.hardwareProfileId !== 'legacy-custom') {
      return {
        ...base,
        status: 'blocked',
        sections: [],
        changes: [],
        warnings: generated.warnings,
        blockedReason: 'AI 硬件修复缺少完整 Hardware Persona，已阻止孤立硬件参数覆盖'
      }
    }

    assertNoUserOverrideChanged(current, changes)
    const sections = [...new Set(changes.map((change) => change.section))]
    const publicPlan: FingerprintRepairPlan = {
      ...base,
      status: 'ready',
      sections,
      changes,
      warnings: generated.warnings
    }
    this.pendingPlans.set(publicPlan.planId, { publicPlan, nextFingerprint })
    return publicPlan
  }

  private async audit(
    auditId: string,
    profileId: string,
    workflowId: string,
    phase: FingerprintRepairAuditPhase,
    changedFields: string[],
    message: string
  ): Promise<void> {
    await this.state.appendAudit({
      auditId,
      profileId,
      workflowId,
      phase,
      changedFields,
      message,
      createdAt: new Date().toISOString()
    })
  }

  private async restoreFingerprintCheckpoint(profileId: string, auditId: string, workflowId: string, changedFields: string[]): Promise<BrowserProfile> {
    const checkpoint = await this.state.checkpoint(profileId)
    if (!checkpoint || checkpoint.auditId !== auditId) throw new Error('指纹修复配置备份不存在或不匹配')
    const latest = this.profiles.get(profileId)
    const draft = profileDraft(latest)
    draft.fingerprint = {
      ...checkpoint.fingerprint,
      disabledSpoofing: [...checkpoint.fingerprint.disabledSpoofing]
    }
    draft.identityConfigProvenance = checkpoint.identityConfigProvenance
    const restored = await this.profiles.update(profileId, draft)
    await this.audit(auditId, profileId, workflowId, 'rolled_back', changedFields, 'Runtime Verify 未通过，已恢复修复前身份配置')
    await this.state.clearCheckpoint(profileId)
    return restored
  }

  async recoverPendingRepairs(): Promise<number> {
    let recovered = 0
    for (const profile of this.profiles.list()) {
      const checkpoint = await this.state.checkpoint(profile.id).catch((error) => {
        this.logger?.error('读取未完成的指纹修复备份失败', { profileId: profile.id, error })
        return null
      })
      if (!checkpoint) continue
      try {
        const draft = profileDraft(profile)
        draft.fingerprint = {
          ...checkpoint.fingerprint,
          disabledSpoofing: [...checkpoint.fingerprint.disabledSpoofing]
        }
        draft.identityConfigProvenance = checkpoint.identityConfigProvenance
        await this.profiles.update(profile.id, draft)
        await this.state.appendAudit({
          auditId: checkpoint.auditId,
          profileId: profile.id,
          workflowId: 'crash-recovery',
          phase: 'rolled_back',
          changedFields: [],
          message: '检测到未完成的 AI 指纹修复，启动时已自动恢复配置备份',
          createdAt: new Date().toISOString()
        })
        await this.state.clearCheckpoint(profile.id)
        recovered += 1
      } catch (error) {
        this.logger?.error('自动恢复未完成的指纹修复失败', { profileId: profile.id, error })
      }
    }
    return recovered
  }

  async execute(
    profileId: string,
    approvedByUser: boolean,
    planId: string,
    requestedSections: IdentityConfigSection[]
  ): Promise<FingerprintRepairExecutionResultInternal> {
    if (!approvedByUser) throw new Error('AI 修复必须由用户明确确认后才能执行')
    this.prunePlans()
    const pending = this.pendingPlans.get(planId)
    if (!pending || pending.publicPlan.profileId !== profileId) throw new Error('AI 修复计划已过期，请重新预览后确认')
    if (pending.publicPlan.status !== 'ready') throw new Error('当前 AI 修复计划不可执行')

    const current = this.profiles.get(profileId)
    if (current.status !== 'closed' && current.status !== 'error') throw new Error('请先关闭浏览器环境再执行 AI 修复')
    if (current.updatedAt !== pending.publicPlan.profileUpdatedAt) {
      this.pendingPlans.delete(planId)
      throw new Error('环境配置已发生变化，请重新生成 AI 修复计划')
    }

    const selectedSections = [...new Set(requestedSections)].filter((section): section is IdentityConfigSection => VALID_SECTIONS.has(section))
    if (!selectedSections.length) throw new Error('请至少选择一个 AI 修复区域')
    if (selectedSections.some((section) => !pending.publicPlan.sections.includes(section))) {
      throw new Error('选择的修复区域不属于当前 AI 修复计划')
    }

    const selectedSet = new Set(selectedSections)
    const changes = pending.publicPlan.changes.filter((change) => selectedSet.has(change.section))
    if (!changes.length) throw new Error('所选区域没有可执行的 AI 修复项')
    assertNoUserOverrideChanged(current, changes)

    const nextFingerprint = applySelectedChanges(current.fingerprint, pending.nextFingerprint, changes)
    const workflow = approveRepairWorkflow(createRepairWorkflow(repairActions(current, changes)))
    if (!validateRepairSafety(workflow)) throw new Error('AI 修复安全检查未通过')
    this.pendingPlans.delete(planId)

    const changedFields = changes.map((change) => change.field)
    const auditId = randomUUID()
    await this.state.createCheckpoint(profileId, auditId, current.fingerprint, current.identityConfigProvenance)
    await this.audit(auditId, profileId, workflow.id, 'backup', changedFields, `已创建身份配置修复前备份；选择区域：${selectedSections.join(', ')}`)

    let applied = false
    try {
      const draft = profileDraft(current)
      draft.fingerprint = nextFingerprint
      draft.identityConfigProvenance = selectedProvenance(current, changes)
      await this.profiles.update(profileId, draft)
      applied = true
      await this.audit(auditId, profileId, workflow.id, 'applied', changedFields, '已应用所选 AI 身份修复配置，等待 Runtime Verify')

      const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
      if (!scopedRuntimeVerify(report, selectedSections)) {
        const restored = await this.restoreFingerprintCheckpoint(profileId, auditId, workflow.id, changedFields)
        this.logger?.error('AI 指纹修复 Runtime Verify 未通过，已回滚', { profileId, auditId, selectedSections })
        return {
          status: 'rolled_back',
          auditId,
          changedFields,
          message: 'AI 修复后的 Runtime Verify 未通过，已自动恢复修复前配置',
          report,
          profile: restored
        }
      }

      const verified = this.profiles.get(profileId)
      await this.audit(auditId, profileId, workflow.id, 'verified', changedFields, '所选区域 Runtime Verify 通过，AI 身份修复已完成')
      await this.state.clearCheckpoint(profileId)
      this.logger?.info('AI 指纹修复已完成', { profileId, auditId, selectedSections, changedFields })
      return {
        status: 'completed',
        auditId,
        changedFields,
        message: report.ready
          ? 'AI 身份修复已应用并通过 Runtime Verify'
          : '所选 AI 修复区域已通过 Runtime Verify；其他未选区域仍存在待处理项',
        report,
        profile: verified
      }
    } catch (error) {
      if (applied) {
        try {
          await this.restoreFingerprintCheckpoint(profileId, auditId, workflow.id, changedFields)
        } catch (rollbackError) {
          await this.audit(auditId, profileId, workflow.id, 'failed', changedFields, 'AI 修复失败且自动回滚失败；保留备份等待恢复').catch(() => undefined)
          this.logger?.error('AI 指纹修复失败且回滚失败', { profileId, auditId, error, rollbackError })
          throw new Error('AI 修复失败，且自动回滚未完成；已保留修复前配置备份')
        }
      } else {
        await this.audit(auditId, profileId, workflow.id, 'failed', changedFields, 'AI 修复在应用配置前失败').catch(() => undefined)
        await this.state.clearCheckpoint(profileId).catch(() => undefined)
      }
      this.logger?.error('AI 指纹修复执行失败', { profileId, auditId, error })
      throw error
    }
  }
}
