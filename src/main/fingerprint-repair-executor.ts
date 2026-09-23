import { randomUUID } from 'node:crypto'
import type {
  BrowserProfile,
  FingerprintRepairAuditPhase,
  FingerprintRepairExecutionSummary,
  FingerprintRuntimeDiagnosticReport,
  IdentityConfigSection,
  ProfileDraft
} from '../shared/types'
import {
  applyAIIdentityConfigProvenance,
  applyAIIdentityConfigToFingerprint,
  generateAIIdentityConfig,
  type AIIdentityGenerationRequest,
  type AIIdentityGenerationResult
} from '../shared/identity-ai-generator'
import {
  HARDWARE_IDENTITY_FIELDS,
  identityConfigSource,
  identitySectionForFingerprintField,
  normalizeIdentityConfigProvenance
} from '../shared/identity-config-provenance'
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

function changedFingerprintFields(before: BrowserProfile['fingerprint'], after: BrowserProfile['fingerprint']): string[] {
  const beforeRecord = before as unknown as Record<string, unknown>
  const afterRecord = after as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])
  return [...keys].filter((key) => JSON.stringify(beforeRecord[key]) !== JSON.stringify(afterRecord[key])).sort()
}

function componentForSection(section: IdentityConfigSection): RepairAction['component'] {
  if (section === 'network') return 'network'
  if (section === 'locale') return 'locale'
  if (section === 'browser') return 'browser'
  return 'hardware'
}

function repairActions(profile: BrowserProfile, changedFields: string[]): RepairAction[] {
  const provenance = normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
  const grouped = new Map<IdentityConfigSection, string[]>()
  for (const key of changedFields) {
    const section = identitySectionForFingerprintField(key)
    grouped.set(section, [...(grouped.get(section) ?? []), key])
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

function assertNoUserOverrideChanged(profile: BrowserProfile, changedFields: string[]): void {
  const provenance = normalizeIdentityConfigProvenance(profile.identityConfigProvenance)
  for (const key of changedFields) {
    const section = identitySectionForFingerprintField(key)
    if (identityConfigSource(provenance, section, key) === 'user') {
      throw new Error(`AI 修复被手动配置保护阻止：${section}.${key}`)
    }
  }
}

export class FingerprintRepairExecutor {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly verifier: FingerprintRuntimeVerifier,
    private readonly state: FingerprintRepairStateStore,
    private readonly logger?: Logger,
    private readonly generateIdentity: IdentityGenerator = generateAIIdentityConfig
  ) {}

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

  async execute(profileId: string, approvedByUser: boolean): Promise<FingerprintRepairExecutionResultInternal> {
    if (!approvedByUser) throw new Error('AI 修复必须由用户明确确认后才能执行')
    const current = this.profiles.get(profileId)
    if (current.status !== 'closed' && current.status !== 'error') throw new Error('请先关闭浏览器环境再执行 AI 修复')

    const request: AIIdentityGenerationRequest = {
      baseFingerprint: current.fingerprint,
      platform: current.fingerprint.platform,
      proxyProtocol: current.proxy.protocol,
      proxyCheck: current.proxyCheck,
      countryCode: current.proxyCheck?.countryCode,
      networkMode: current.proxy.protocol === 'direct' ? 'manual' : 'proxy'
    }
    const generated = this.generateIdentity(request)
    const nextFingerprint = applyAIIdentityConfigToFingerprint(
      current.fingerprint,
      generated,
      current.identityConfigProvenance
    )
    const changedFields = changedFingerprintFields(current.fingerprint, nextFingerprint)
    if (!changedFields.length) {
      throw new Error('当前没有可由 AI 自动修复的配置；手动配置项只提供建议，不会被覆盖')
    }
    const hardwareChanges = changedFields.filter((key) =>
      HARDWARE_IDENTITY_FIELDS.includes(key as (typeof HARDWARE_IDENTITY_FIELDS)[number])
    )
    if (hardwareChanges.length && !generated.personaId && current.fingerprint.hardwareProfileId !== 'legacy-custom') {
      throw new Error('AI 硬件修复缺少完整 Hardware Persona，已阻止孤立硬件参数覆盖')
    }
    assertNoUserOverrideChanged(current, changedFields)

    const workflow = approveRepairWorkflow(createRepairWorkflow(repairActions(current, changedFields)))
    if (!validateRepairSafety(workflow)) throw new Error('AI 修复安全检查未通过')

    const auditId = randomUUID()
    await this.state.createCheckpoint(profileId, auditId, current.fingerprint, current.identityConfigProvenance)
    await this.audit(auditId, profileId, workflow.id, 'backup', changedFields, '已创建身份配置修复前备份')

    let applied = false
    try {
      const draft = profileDraft(current)
      draft.fingerprint = nextFingerprint
      draft.identityConfigProvenance = applyAIIdentityConfigProvenance(current.identityConfigProvenance, generated)
      await this.profiles.update(profileId, draft)
      applied = true
      await this.audit(auditId, profileId, workflow.id, 'applied', changedFields, '已应用 AI 身份修复配置，等待 Runtime Verify')

      const report = await this.verifier.diagnoseFingerprintRuntime(profileId)
      if (!report.ready) {
        const restored = await this.restoreFingerprintCheckpoint(profileId, auditId, workflow.id, changedFields)
        this.logger?.error('AI 指纹修复 Runtime Verify 未通过，已回滚', { profileId, auditId })
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
      await this.audit(auditId, profileId, workflow.id, 'verified', changedFields, 'Runtime Verify 通过，AI 身份修复已完成')
      await this.state.clearCheckpoint(profileId)
      this.logger?.info('AI 指纹修复已完成', { profileId, auditId, changedFields })
      return {
        status: 'completed',
        auditId,
        changedFields,
        message: 'AI 身份修复已应用并通过 Runtime Verify',
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
