import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from '@ant-design/icons'
import { Alert, Button, Checkbox, Divider, List, Modal, Popconfirm, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { buildAIDiagnosisContext } from '../../shared/fingerprint-ai-diagnosis'
import { buildFingerprintHealthModel } from '../../shared/fingerprint-health-aggregator'
import { diagnosticChecksToHealthSignals } from '../../shared/fingerprint-health-adapter'
import { buildRepairProposals } from '../../shared/fingerprint-repair-proposal'
import type { FingerprintConfigReference, FingerprintRiskLevel } from '../../shared/fingerprint-health-model'
import type {
  BrowserProfileView,
  FingerprintRepairAuditPhase,
  FingerprintRepairAuditRecord,
  FingerprintRepairPlan,
  IdentityConfigSection,
  IdentityConfigSource,
  FingerprintRuntimeDiagnosticReport
} from '../../shared/types'

interface LaunchDiagnosticsModalProps {
  profile?: BrowserProfileView
  report?: FingerprintRuntimeDiagnosticReport
  open: boolean
  repairing?: boolean
  onExecuteStrategy?: () => Promise<void> | void
  onRepair?: (planId: string, sections: IdentityConfigSection[]) => Promise<void> | void
  onClose: () => void
}

const statusView = {
  pass: { color: 'success', text: '通过', icon: <CheckCircleFilled /> },
  warning: { color: 'warning', text: '提醒', icon: <WarningFilled /> },
  error: { color: 'error', text: '失败', icon: <CloseCircleFilled /> }
} as const

const sourceView: Record<IdentityConfigSource, { color: string; text: string }> = {
  default: { color: 'default', text: '默认配置' },
  ai: { color: 'blue', text: 'AI 配置' },
  user: { color: 'magenta', text: '手动配置' }
}

const riskView: Record<FingerprintRiskLevel, { color: string; text: string }> = {
  low: { color: 'success', text: '低风险' },
  medium: { color: 'warning', text: '中风险' },
  high: { color: 'volcano', text: '高风险' },
  critical: { color: 'error', text: '严重风险' }
}

const sectionView: Record<IdentityConfigSection, string> = {
  fingerprint: '硬件 / 指纹',
  network: '网络身份',
  locale: '语言 / 时区',
  browser: '浏览器身份'
}

const selfHealingModeView = {
  manual: 'Manual',
  assisted: 'Assisted',
  auto: 'Auto'
} as const

const selfHealingDecisionView = {
  disabled: { color: 'default', text: '只监控' },
  suggest: { color: 'blue', text: '等待确认' },
  auto_execute: { color: 'success', text: '自动执行' },
  cooldown: { color: 'warning', text: '冷却中' },
  blocked: { color: 'error', text: '保护阻止' }
} as const

const strategyView = {
  none: { color: 'default', text: '无需修复' },
  switch_proxy: { color: 'purple', text: '切换代理' },
  regenerate_identity: { color: 'volcano', text: '重生成 Identity' },
  repair_configuration: { color: 'blue', text: '修复配置' },
  replace_baseline: { color: 'cyan', text: '换代 Baseline' },
  manual_review: { color: 'warning', text: '人工确认' }
} as const

const phaseView: Record<FingerprintRepairAuditPhase, { color: string; text: string }> = {
  backup: { color: 'processing', text: '已备份' },
  applied: { color: 'blue', text: '已应用' },
  verified: { color: 'success', text: '验证通过' },
  rolled_back: { color: 'warning', text: '已回滚' },
  failed: { color: 'error', text: '失败' }
}

function uniqueSources(references: FingerprintConfigReference[]): IdentityConfigSource[] {
  return [...new Set(references.map((reference) => reference.source))]
}

function displayValue(value: unknown): string {
  if (value === undefined) return '未设置'
  if (typeof value === 'string') return value || '空'
  const text = JSON.stringify(value)
  if (!text) return String(value)
  return text.length > 100 ? `${text.slice(0, 97)}...` : text
}

export function LaunchDiagnosticsModal({
  profile,
  report,
  open,
  repairing = false,
  onExecuteStrategy,
  onRepair,
  onClose
}: LaunchDiagnosticsModalProps) {
  const [repairPlan, setRepairPlan] = useState<FingerprintRepairPlan>()
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string>()
  const [selectedSections, setSelectedSections] = useState<IdentityConfigSection[]>([])
  const [repairHistory, setRepairHistory] = useState<FingerprintRepairAuditRecord[]>([])

  useEffect(() => {
    if (!open || !profile) {
      setRepairPlan(undefined)
      setSelectedSections([])
      setRepairHistory([])
      setPlanError(undefined)
      return
    }

    let active = true
    setPlanLoading(true)
    setPlanError(undefined)

    void window.browserApi.profiles.planFingerprintRepair(profile.id)
      .then((plan) => {
        if (!active) return
        setRepairPlan(plan)
        setSelectedSections(plan.status === 'ready' ? plan.sections : [])
      })
      .catch((error) => {
        if (!active) return
        setRepairPlan(undefined)
        setSelectedSections([])
        setPlanError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (active) setPlanLoading(false)
      })

    void window.browserApi.profiles.fingerprintRepairHistory(profile.id)
      .then((history) => {
        if (active) setRepairHistory([...history].reverse())
      })
      .catch(() => {
        if (active) setRepairHistory([])
      })

    return () => {
      active = false
    }
  }, [open, profile?.id, profile?.updatedAt, report?.checkedAt])

  const signals = report
    ? diagnosticChecksToHealthSignals(report.checks, profile?.identityConfigProvenance)
    : []
  const fallbackHealth = report ? buildFingerprintHealthModel(signals) : undefined
  const health = report?.identityHealth ?? fallbackHealth
  const diagnosis = report?.identityDiagnosis ?? (health ? buildAIDiagnosisContext(health) : undefined)
  const proposals = diagnosis ? buildRepairProposals(diagnosis) : []
  const proposalByKey = new Map(proposals.filter((proposal) => proposal.signalKey).map((proposal) => [proposal.signalKey!, proposal]))
  const signalByKey = new Map(signals.map((signal) => [signal.key, signal]))

  function toggleSection(section: IdentityConfigSection, checked: boolean): void {
    setSelectedSections((current) => checked
      ? [...new Set([...current, section])]
      : current.filter((item) => item !== section))
  }

  return (
    <Modal open={open} title={`身份健康诊断${profile ? ` · ${profile.name}` : ''}`} footer={null} onCancel={onClose} destroyOnHidden width={900}>
      {report && health && diagnosis && (
        <>
          <Alert
            type={report.ready ? 'success' : 'error'}
            showIcon
            title={report.ready ? '未发现阻止启动的问题' : '发现可能导致启动失败的问题'}
            description={report.ready ? '提醒项不会阻止启动，但建议在正式业务使用前处理。' : '请处理失败项后重新诊断。'}
          />

          <Space wrap style={{ marginTop: 12, marginBottom: 4 }}>
            <Tag color={riskView[health.risk].color}>健康分 {health.score} · {riskView[health.risk].text}</Tag>
            {report.identityBaseline && (
              <Tag color={report.identityBaseline.status === 'active' ? 'blue' : 'warning'}>
                Baseline v{report.identityBaseline.version} · {report.identityBaseline.status}
              </Tag>
            )}
            {report.identityDrift?.driftDetected && (
              <Tag color={report.identityDrift.severity === 'critical' ? 'error' : report.identityDrift.severity === 'high' ? 'volcano' : 'warning'}>
                Drift {report.identityDrift.severity} · {report.identityDrift.changes.length} 项
              </Tag>
            )}
            {report.identityHealthTrend && (
              <Tag>
                趋势 {report.identityHealthTrend.direction === 'improving'
                  ? '↗ 改善'
                  : report.identityHealthTrend.direction === 'degrading'
                    ? '↘ 恶化'
                    : report.identityHealthTrend.direction === 'stable'
                      ? '→ 稳定'
                      : '首次记录'}
              </Tag>
            )}
            {diagnosis.protectedUserOverrides > 0 && (
              <Tag color="magenta">手动配置保护 {diagnosis.protectedUserOverrides} 项</Tag>
            )}
          </Space>

          {report.identityDiagnosis?.summary && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
              {report.identityDiagnosis.summary}
            </Typography.Paragraph>
          )}

          {report.identitySelfHealing && (
            <Alert
              style={{ marginTop: 8 }}
              type={report.identitySelfHealing.decision === 'blocked'
                ? 'error'
                : report.identitySelfHealing.decision === 'cooldown'
                  ? 'warning'
                  : report.identitySelfHealing.decision === 'auto_execute'
                    ? 'success'
                    : 'info'}
              showIcon
              title={
                <Space wrap>
                  <Typography.Text strong>
                    Self-Healing · {selfHealingModeView[report.identitySelfHealing.mode]}
                  </Typography.Text>
                  <Tag color={selfHealingDecisionView[report.identitySelfHealing.decision].color}>
                    {selfHealingDecisionView[report.identitySelfHealing.decision].text}
                  </Tag>
                  {report.identitySelfHealing.pending && <Tag color="processing">Pending</Tag>}
                </Space>
              }
              description={
                <Space direction="vertical" size={2}>
                  <Typography.Text>{report.identitySelfHealing.reason}</Typography.Text>
                  <Typography.Text type="secondary">
                    最近 1 小时自动尝试 {report.identitySelfHealing.attemptsInWindow} / 3
                    {report.identitySelfHealing.consecutiveFailures
                      ? ` · 连续失败 ${report.identitySelfHealing.consecutiveFailures}`
                      : ''}
                    {report.identitySelfHealing.cooldownUntil
                      ? ` · 冷却至 ${new Date(report.identitySelfHealing.cooldownUntil).toLocaleString()}`
                      : ''}
                  </Typography.Text>
                  {report.identitySelfHealing.lastMessage && (
                    <Typography.Text type="secondary">上次结果：{report.identitySelfHealing.lastMessage}</Typography.Text>
                  )}
                </Space>
              }
            />
          )}

          {report.identityRepairStrategy && report.identityRepairStrategy.kind !== 'none' && (
            <Alert
              style={{ marginTop: 8 }}
              type={report.identityRepairStrategy.kind === 'manual_review' ? 'warning' : 'info'}
              showIcon
              title={`AI 恢复策略 · ${strategyView[report.identityRepairStrategy.kind].text}`}
              description={
                <Space direction="vertical" size={2}>
                  <Typography.Text>{report.identityRepairStrategy.reason}</Typography.Text>
                  {report.identityRepairStrategy.candidateProxy && (
                    <Typography.Text type="secondary">
                      推荐代理：{report.identityRepairStrategy.candidateProxy.name} · {report.identityRepairStrategy.candidateProxy.countryCode} · 评分 {report.identityRepairStrategy.candidateProxy.score}
                    </Typography.Text>
                  )}
                  {!report.identityRepairStrategy.automaticActionAvailable && report.identityRepairStrategy.kind !== 'manual_review' && (
                    <Typography.Text type="secondary">当前没有可自动执行的候选资源，需要先补充可用代理或人工配置。</Typography.Text>
                  )}
                  {onExecuteStrategy
                    && report.identityRepairStrategy.automaticActionAvailable
                    && report.identityRepairStrategy.kind !== 'manual_review' && (
                      report.identityRepairStrategy.requiresUserConfirmation ? (
                        <Popconfirm
                          title="确认执行当前 Identity Repair Strategy？"
                          description="执行后会自动 Runtime Verify；验证失败时会按策略回滚可恢复的配置。"
                          okText="确认执行"
                          cancelText="取消"
                          onConfirm={onExecuteStrategy}
                        >
                          <Button type="primary" loading={repairing}>
                            执行恢复策略
                          </Button>
                        </Popconfirm>
                      ) : (
                        <Button type="primary" loading={repairing} onClick={onExecuteStrategy}>
                          执行恢复策略
                        </Button>
                      )
                    )}
                </Space>
              }
            />
          )}

          {diagnosis.protectedUserOverrides > 0 && (
            <Alert
              style={{ marginTop: 8 }}
              type="info"
              showIcon
              title="检测到问题关联用户手动配置"
              description="AI 可以分析并给出修复建议，但不会自动覆盖这些手动配置。需要调整时请由用户在环境配置中修改。"
            />
          )}

          <Divider titlePlacement="start">AI 修复计划</Divider>
          {planLoading && <Spin size="small" />}
          {planError && (
            <Alert type="warning" showIcon title="无法生成 AI 修复计划" description={planError} />
          )}
          {!planLoading && repairPlan?.status === 'blocked' && (
            <Alert type="warning" showIcon title="AI 修复计划已阻止" description={repairPlan.blockedReason} />
          )}
          {!planLoading && repairPlan?.status === 'no_changes' && (
            <Alert
              type={repairPlan.strategy && repairPlan.strategy.kind !== 'none' ? 'info' : 'success'}
              showIcon
              title={repairPlan.strategy && repairPlan.strategy.kind !== 'none'
                ? `当前策略：${strategyView[repairPlan.strategy.kind].text}`
                : '没有可自动修改的配置'}
              description={repairPlan.strategy && repairPlan.strategy.kind !== 'none'
                ? repairPlan.strategy.reason
                : '当前差异要么已经一致，要么属于受保护的手动配置。'}
            />
          )}
          {!planLoading && repairPlan?.status === 'ready' && (
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              <Alert
                type="info"
                showIcon
                title={`预览到 ${repairPlan.changes.length} 项配置变更`}
                description="你可以按身份区域选择执行。确认后才会创建备份并应用；计划有效期 10 分钟，环境发生变化后必须重新预览。"
              />
              <Space wrap>
                {repairPlan.sections.map((section) => (
                  <Checkbox
                    key={section}
                    checked={selectedSections.includes(section)}
                    onChange={(event) => toggleSection(section, event.target.checked)}
                  >
                    {sectionView[section]}
                  </Checkbox>
                ))}
              </Space>
              <List
                size="small"
                bordered
                dataSource={repairPlan.changes}
                renderItem={(change) => (
                  <List.Item>
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Space wrap>
                        <Tag>{sectionView[change.section]}</Tag>
                        <Typography.Text strong>{change.field}</Typography.Text>
                        <Tag color={sourceView[change.source].color}>{sourceView[change.source].text}</Tag>
                        {!selectedSections.includes(change.section) && <Tag>本次不执行</Tag>}
                      </Space>
                      <Typography.Text type="secondary">
                        {displayValue(change.before)} → {displayValue(change.after)}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
              {repairPlan.warnings.length > 0 && (
                <Alert type="warning" showIcon title="计划提醒" description={repairPlan.warnings.join('；')} />
              )}
              {onRepair && (
                <Popconfirm
                  title="确认应用所选 AI 身份修复？"
                  description="只执行上面勾选的区域；所有手动配置继续保持保护。"
                  okText="确认修复"
                  cancelText="取消"
                  onConfirm={() => onRepair(repairPlan.planId, selectedSections)}
                  disabled={!selectedSections.length}
                >
                  <Button type="primary" loading={repairing} disabled={!selectedSections.length}>
                    确认并执行所选修复
                  </Button>
                </Popconfirm>
              )}
            </Space>
          )}

          <Divider titlePlacement="start">诊断明细</Divider>
          <List
            className="diagnostics-list"
            dataSource={report.checks}
            renderItem={(check) => {
              const view = statusView[check.status]
              const signal = signalByKey.get(check.key)
              const references = signal?.configReferences ?? []
              const proposal = proposalByKey.get(check.key)
              return (
                <List.Item>
                  <List.Item.Meta
                    title={(
                      <Space wrap>
                        <Tag color={view.color} icon={view.icon}>{view.text}</Tag>
                        <Typography.Text strong>{check.label}</Typography.Text>
                        {uniqueSources(references).map((source) => (
                          <Tag key={source} color={sourceView[source].color}>{sourceView[source].text}</Tag>
                        ))}
                        {proposal && (
                          <Tag color={proposal.protectedByUserOverride ? 'magenta' : 'blue'}>
                            {proposal.protectedByUserOverride ? '仅建议' : '确认后可修复'}
                          </Tag>
                        )}
                      </Space>
                    )}
                    description={(
                      <Space direction="vertical" size={2}>
                        <Typography.Text type="secondary">{check.message}</Typography.Text>
                        {proposal && check.status !== 'pass' && (
                          <Typography.Text type="secondary">
                            AI 建议：{proposal.actions.join('；')}
                          </Typography.Text>
                        )}
                      </Space>
                    )}
                  />
                </List.Item>
              )
            }}
          />

          <Divider titlePlacement="start">AI 修复审计</Divider>
          {repairHistory.length === 0 ? (
            <Typography.Text type="secondary">暂无 AI 修复执行记录。</Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={repairHistory.slice(0, 20)}
              renderItem={(record) => (
                <List.Item>
                  <Space direction="vertical" size={2}>
                    <Space wrap>
                      <Tag color={phaseView[record.phase].color}>{phaseView[record.phase].text}</Tag>
                      <Typography.Text>{new Date(record.createdAt).toLocaleString()}</Typography.Text>
                      {record.changedFields.length > 0 && (
                        <Typography.Text type="secondary">{record.changedFields.join(', ')}</Typography.Text>
                      )}
                    </Space>
                    <Typography.Text type="secondary">{record.message}</Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          )}

          <Typography.Text type="secondary">检查时间：{new Date(report.checkedAt).toLocaleString()}</Typography.Text>
        </>
      )}
    </Modal>
  )
}
