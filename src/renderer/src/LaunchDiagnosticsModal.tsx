import { CheckCircleFilled, CloseCircleFilled, WarningFilled } from '@ant-design/icons'
import { Alert, Button, List, Modal, Popconfirm, Space, Tag, Typography } from 'antd'
import { buildAIDiagnosisContext } from '../../shared/fingerprint-ai-diagnosis'
import { buildFingerprintHealthModel } from '../../shared/fingerprint-health-aggregator'
import { diagnosticChecksToHealthSignals } from '../../shared/fingerprint-health-adapter'
import { buildRepairProposals } from '../../shared/fingerprint-repair-proposal'
import type { FingerprintConfigReference, FingerprintRiskLevel } from '../../shared/fingerprint-health-model'
import type { BrowserProfileView, IdentityConfigSource, LaunchDiagnosticReport } from '../../shared/types'

interface LaunchDiagnosticsModalProps {
  profile?: BrowserProfileView
  report?: LaunchDiagnosticReport
  open: boolean
  repairing?: boolean
  onRepair?: () => Promise<void> | void
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

function uniqueSources(references: FingerprintConfigReference[]): IdentityConfigSource[] {
  return [...new Set(references.map((reference) => reference.source))]
}

export function LaunchDiagnosticsModal({ profile, report, open, repairing = false, onRepair, onClose }: LaunchDiagnosticsModalProps) {
  const signals = report
    ? diagnosticChecksToHealthSignals(report.checks, profile?.identityConfigProvenance)
    : []
  const health = report ? buildFingerprintHealthModel(signals) : undefined
  const diagnosis = health ? buildAIDiagnosisContext(health) : undefined
  const proposals = diagnosis ? buildRepairProposals(diagnosis) : []
  const proposalByKey = new Map(proposals.filter((proposal) => proposal.signalKey).map((proposal) => [proposal.signalKey!, proposal]))
  const signalByKey = new Map(signals.map((signal) => [signal.key, signal]))
  const repairableCount = proposals.filter((proposal) => proposal.automatedRepairAllowed).length

  return (
    <Modal open={open} title={`启动诊断${profile ? ` · ${profile.name}` : ''}`} footer={null} onCancel={onClose} destroyOnHidden width={720}>
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
            {diagnosis.protectedUserOverrides > 0 && (
              <Tag color="magenta">手动配置保护 {diagnosis.protectedUserOverrides} 项</Tag>
            )}
          </Space>
          {diagnosis.protectedUserOverrides > 0 && (
            <Alert
              style={{ marginTop: 8 }}
              type="info"
              showIcon
              title="检测到问题关联用户手动配置"
              description="AI 可以分析并给出修复建议，但不会自动覆盖这些手动配置。需要调整时请由用户在环境配置中修改。"
            />
          )}
          {repairableCount > 0 && onRepair && (
            <Alert
              style={{ marginTop: 8 }}
              type="info"
              showIcon
              title={`发现 ${repairableCount} 项可由 AI 修复的配置`}
              description="执行流程：保存修复前配置备份 → 应用 AI 配置 → 实际启动 Runtime Verify；验证失败会自动回滚。手动配置始终保持不变。"
              action={(
                <Popconfirm
                  title="确认应用 AI 身份修复？"
                  description="只会修改 AI / 默认配置，手动配置不会被覆盖。"
                  okText="确认修复"
                  cancelText="取消"
                  onConfirm={() => onRepair()}
                >
                  <Button type="primary" loading={repairing}>确认并应用 AI 修复</Button>
                </Popconfirm>
              )}
            />
          )}
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
          <Typography.Text type="secondary">检查时间：{new Date(report.checkedAt).toLocaleString()}</Typography.Text>
        </>
      )}
    </Modal>
  )
}
