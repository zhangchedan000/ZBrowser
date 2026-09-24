import { Button, Modal, Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd'
import { useState } from 'react'
import type { BrowserProfileView, IdentitySelfHealingAttemptRecord, IdentitySelfHealingSummary } from '../../shared/types'

interface SelfHealingControlCenterModalProps {
  open: boolean
  profiles: BrowserProfileView[]
  states: Record<string, IdentitySelfHealingSummary>
  loading?: boolean
  batchLoading?: boolean
  executingProfileId?: string
  onRefresh: () => Promise<void> | void
  onBatchDiagnose: (profiles: BrowserProfileView[]) => Promise<void> | void
  onExecute: (profile: BrowserProfileView) => Promise<void> | void
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
  batchLoading = false,
  executingProfileId,
  onRefresh,
  onBatchDiagnose,
  onExecute,
  onDiagnose,
  onClose
}: SelfHealingControlCenterModalProps) {
  const [historyProfile, setHistoryProfile] = useState<BrowserProfileView>()
  const [historyRecords, setHistoryRecords] = useState<IdentitySelfHealingAttemptRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  async function openHistory(profile: BrowserProfileView): Promise<void> {
    setHistoryProfile(profile)
    setHistoryRecords([])
    setHistoryLoading(true)
    try {
      setHistoryRecords(await window.browserApi.profiles.identitySelfHealingHistory(profile.id))
    } catch (error) {
      Modal.error({
        title: '读取 Self-Healing 历史失败',
        content: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setHistoryLoading(false)
    }
  }

  const rows = profiles.map((profile) => ({
    profile,
    state: states[profile.id] ?? fallback(profile)
  }))
  const pendingCount = rows.filter((row) => row.state.pending).length
  const blockedCount = rows.filter((row) => row.state.decision === 'blocked' || row.state.decision === 'cooldown').length
  const autoCount = rows.filter((row) => row.state.mode === 'auto').length
  const batchCandidates = rows
    .filter((row) => ['closed', 'error'].includes(row.profile.status))
    .map((row) => row.profile)

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
              {row.state.lastAttemptTrigger === 'user' ? '人工确认' : 'Auto'}
              {' · '}
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
      width: 250,
      fixed: 'right',
      render: (_value, row) => {
        const executable = row.state.pending
          && row.state.pendingStrategyKind !== 'manual_review'
          && !['cooldown', 'blocked'].includes(row.state.decision)
          && ['closed', 'error'].includes(row.profile.status)
        return (
          <Space size={6}>
            {row.state.pending && row.state.pendingStrategyKind !== 'manual_review' && (
              <Button
                size="small"
                type="primary"
                danger={row.state.pendingStrategyKind === 'regenerate_identity' || row.state.pendingStrategyKind === 'switch_proxy'}
                loading={executingProfileId === row.profile.id}
                disabled={!executable || (executingProfileId !== undefined && executingProfileId !== row.profile.id)}
                onClick={() => {
                  Modal.confirm({
                    title: '确认执行 Self-Healing 恢复？',
                    content: (
                      <Space direction="vertical" size={4}>
                        <Typography.Text>环境：#{row.profile.serialNumber} · {row.profile.name}</Typography.Text>
                        <Typography.Text>策略：{strategyText[row.state.pendingStrategyKind!]}</Typography.Text>
                        <Typography.Text type="secondary">{row.state.pendingReason ?? row.state.reason}</Typography.Text>
                        <Typography.Text type="secondary">执行后会再次做 Runtime Verify；验证失败的可回滚策略会自动恢复原状态。</Typography.Text>
                      </Space>
                    ),
                    okText: '确认执行',
                    cancelText: '取消',
                    okButtonProps: {
                      danger: row.state.pendingStrategyKind === 'regenerate_identity' || row.state.pendingStrategyKind === 'switch_proxy'
                    },
                    onOk: () => onExecute(row.profile)
                  })
                }}
              >
                确认执行
              </Button>
            )}
            <Button
              size="small"
              disabled={!['closed', 'error'].includes(row.profile.status)}
              onClick={() => void onDiagnose(row.profile)}
            >
              检查
            </Button>
            <Button size="small" onClick={() => void openHistory(row.profile)}>
              历史
            </Button>
          </Space>
        )
      }
    }
  ]

  const historyColumns: TableColumnsType<IdentitySelfHealingAttemptRecord> = [
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString()
    },
    {
      title: '来源',
      dataIndex: 'trigger',
      width: 100,
      render: (value: IdentitySelfHealingAttemptRecord['trigger']) => (
        <Tag color={value === 'user' ? 'blue' : 'success'}>{value === 'user' ? '人工确认' : 'Auto'}</Tag>
      )
    },
    {
      title: '策略',
      dataIndex: 'strategyKind',
      width: 160,
      render: (value: IdentitySelfHealingAttemptRecord['strategyKind']) => strategyText[value]
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 120,
      render: (value: IdentitySelfHealingAttemptRecord['result']) => {
        if (!value) return <Tag color="processing">执行中</Tag>
        const color = value === 'completed' ? 'success'
          : value === 'rolled_back' ? 'warning'
            : value === 'failed' ? 'error'
              : 'default'
        return <Tag color={color}>{value}</Tag>
      }
    },
    {
      title: '耗时',
      key: 'duration',
      width: 100,
      render: (_value, record) => {
        if (!record.completedAt) return <Typography.Text type="secondary">—</Typography.Text>
        const milliseconds = Math.max(0, Date.parse(record.completedAt) - Date.parse(record.startedAt))
        return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`
      }
    },
    {
      title: '消息',
      dataIndex: 'message',
      render: (value?: string) => value
        ? <Tooltip title={value}><Typography.Text ellipsis style={{ maxWidth: 300 }}>{value}</Typography.Text></Tooltip>
        : <Typography.Text type="secondary">—</Typography.Text>
    }
  ]

  return (
    <>
    <Modal
      open={open}
      width={1180}
      title="Self-Healing Control Center"
      onCancel={onClose}
      footer={[
        <Button
          key="batch"
          loading={batchLoading}
          disabled={!batchCandidates.length || Boolean(executingProfileId)}
          onClick={() => {
            Modal.confirm({
              title: `批量检查 ${batchCandidates.length} 个环境？`,
              content: (
                <Space direction="vertical" size={4}>
                  <Typography.Text>只会处理当前已关闭或异常的环境，并按顺序逐个执行。</Typography.Text>
                  <Typography.Text type="secondary">
                    Auto 环境仍只执行现有低风险白名单；Assisted 和高风险策略只会进入待确认，不会批量越权执行。
                  </Typography.Text>
                </Space>
              ),
              okText: '开始批量检查',
              cancelText: '取消',
              onOk: () => onBatchDiagnose(batchCandidates)
            })
          }}
        >
          批量检查 ({batchCandidates.length})
        </Button>,
        <Button key="refresh" loading={loading} onClick={() => void onRefresh()}>刷新状态</Button>,
        <Button key="close" type="primary" onClick={onClose}>关闭</Button>
      ]}
    >
      <Space wrap style={{ marginBottom: 16 }}>
        <Tag color="success">Auto {autoCount}</Tag>
        <Tag color={pendingCount ? 'processing' : 'default'}>Pending {pendingCount}</Tag>
        <Tag color={blockedCount ? 'warning' : 'default'}>Cooldown / Blocked {blockedCount}</Tag>
        <Tag color="default">可批量检查 {batchCandidates.length}</Tag>
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
        scroll={{ x: 1410 }}
      />
    </Modal>
    <Modal
      open={Boolean(historyProfile)}
      width={920}
      title={historyProfile ? `Self-Healing 历史 · #${historyProfile.serialNumber} · ${historyProfile.name}` : 'Self-Healing 历史'}
      onCancel={() => {
        setHistoryProfile(undefined)
        setHistoryRecords([])
      }}
      footer={[
        <Button key="close" type="primary" onClick={() => {
          setHistoryProfile(undefined)
          setHistoryRecords([])
        }}>关闭</Button>
      ]}
    >
      <Table
        size="small"
        rowKey="id"
        columns={historyColumns}
        dataSource={historyRecords}
        loading={historyLoading}
        pagination={historyRecords.length > 10 ? { pageSize: 10 } : false}
        scroll={{ x: 900 }}
        locale={{ emptyText: '暂无 Self-Healing 执行记录' }}
      />
    </Modal>
    </>
  )
}
