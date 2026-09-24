import { Button, Modal, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd'
import type { BrowserProfileView, IdentitySelfHealingSummary } from '../../shared/types'

interface SelfHealingControlCenterModalProps {
  open: boolean
  profiles: BrowserProfileView[]
  states: Record<string, IdentitySelfHealingSummary>
  loading?: boolean
  onRefresh: () => Promise<void> | void
  onDiagnose: (profile: BrowserProfileView) => Promise<void> | void
  onClose: () => void
}

const modeView = {
  manual: { color: 'default', text: 'Manual' },
  assisted: { color: 'blue', text: 'Assisted' },
  auto: { color: 'success', text: 'Auto' }
} as const

const decisionView = {
  disabled: { color: 'default', text: '只监控' },
  suggest: { color: 'blue', text: '等待确认' },
  auto_execute: { color: 'success', text: '自动恢复' },
  cooldown: { color: 'warning', text: '冷却中' },
  blocked: { color: 'error', text: '保护阻止' }
} as const

const strategyText = {
  none: '无需修复',
  switch_proxy: '切换代理',
  regenerate_identity: '重生成 Identity',
  repair_configuration: '修复配置',
  replace_baseline: '换代 Baseline',
  manual_review: '人工确认'
} as const

function fallback(profile: BrowserProfileView): IdentitySelfHealingSummary {
  const mode = profile.identityIntent?.selfHealingMode ?? 'assisted'
  return {
    mode,
    decision: mode === 'manual' ? 'disabled' : 'suggest',
    reason: mode === 'manual' ? 'Self-Healing 为 Manual，仅监控身份状态' : '当前没有待处理的 Self-Healing 任务',
    pending: false,
    attemptsInWindow: 0,
    consecutiveFailures: 0
  }
}

export function SelfHealingControlCenterModal({
  open,
  profiles,
  states,
  loading = false,
  onRefresh,
  onDiagnose,
  onClose
}: SelfHealingControlCenterModalProps) {
  const rows = profiles.map((profile) => ({
    profile,
    state: states[profile.id] ?? fallback(profile)
  }))
  const pendingCount = rows.filter((row) => row.state.pending).length
  const blockedCount = rows.filter((row) => row.state.decision === 'blocked' || row.state.decision === 'cooldown').length
  const autoCount = rows.filter((row) => row.state.mode === 'auto').length

  const columns: TableColumnsType<(typeof rows)[number]> = [
    {
      title: '环境',
      key: 'profile',
      width: 220,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>#{row.profile.serialNumber} · {row.profile.name}</Typography.Text>
          <Typography.Text type="secondary">{row.profile.environmentType === 'temporary' ? '临时环境' : '账号环境'}</Typography.Text>
        </Space>
      )
    },
    {
      title: '模式',
      key: 'mode',
      width: 110,
      render: (_value, row) => {
        const view = modeView[row.state.mode]
        return <Tag color={view.color}>{view.text}</Tag>
      }
    },
    {
      title: '状态',
      key: 'decision',
      width: 150,
      render: (_value, row) => {
        const view = decisionView[row.state.decision]
        return (
          <Space size={4} wrap>
            <Tag color={view.color}>{view.text}</Tag>
            {row.state.pending && <Tag color="processing">Pending</Tag>}
          </Space>
        )
      }
    },
    {
      title: '待处理策略',
      key: 'pending',
      width: 220,
      render: (_value, row) => row.state.pendingStrategyKind ? (
        <Tooltip title={row.state.pendingReason ?? row.state.reason}>
          <Space direction="vertical" size={0}>
            <Typography.Text>{strategyText[row.state.pendingStrategyKind]}</Typography.Text>
            {row.state.pendingDetectedAt && (
              <Typography.Text type="secondary">{new Date(row.state.pendingDetectedAt).toLocaleString()}</Typography.Text>
            )}
          </Space>
        </Tooltip>
      ) : <Typography.Text type="secondary">无</Typography.Text>
    },
    {
      title: '保护',
      key: 'guard',
      width: 220,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>最近 1 小时 {row.state.attemptsInWindow} / 3 次</Typography.Text>
          {row.state.consecutiveFailures > 0 && (
            <Typography.Text type="danger">连续失败 {row.state.consecutiveFailures}</Typography.Text>
          )}
          {row.state.cooldownUntil && (
            <Typography.Text type="secondary">至 {new Date(row.state.cooldownUntil).toLocaleString()}</Typography.Text>
          )}
        </Space>
      )
    },
    {
      title: '最近结果',
      key: 'last',
      width: 240,
      render: (_value, row) => row.state.lastAttemptAt ? (
        <Tooltip title={row.state.lastMessage}>
          <Space direction="vertical" size={0}>
            <Typography.Text>
              {row.state.lastStrategyKind ? strategyText[row.state.lastStrategyKind] : 'Self-Healing'}
              {row.state.lastResult ? ` · ${row.state.lastResult}` : ''}
            </Typography.Text>
            <Typography.Text type="secondary">{new Date(row.state.lastAttemptAt).toLocaleString()}</Typography.Text>
          </Space>
        </Tooltip>
      ) : <Typography.Text type="secondary">尚无自动恢复记录</Typography.Text>
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_value, row) => (
        <Button
          size="small"
          disabled={!['closed', 'error'].includes(row.profile.status)}
          onClick={() => void onDiagnose(row.profile)}
        >
          检查
        </Button>
      )
    }
  ]

  return (
    <Modal
      open={open}
      width={1180}
      title="Self-Healing Control Center"
      onCancel={onClose}
      footer={[
        <Button key="refresh" loading={loading} onClick={() => void onRefresh()}>刷新状态</Button>,
        <Button key="close" type="primary" onClick={onClose}>关闭</Button>
      ]}
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Tag color="success">Auto {autoCount}</Tag>
        <Tag color={pendingCount ? 'processing' : 'default'}>Pending {pendingCount}</Tag>
        <Tag color={blockedCount ? 'warning' : 'default'}>Cooldown / Blocked {blockedCount}</Tag>
        <Typography.Text type="secondary">
          Auto 只执行低风险白名单；账号环境自动换代理、完整 Identity 重生成等高风险动作仍需确认。
        </Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey={(row) => row.profile.id}
        columns={columns}
        dataSource={rows}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
        scroll={{ x: 1260 }}
      />
    </Modal>
  )
}
