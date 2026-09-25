import { Alert, Button, Divider, Modal, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type {
  AutomationApiStatus,
  AutomationAttentionAuditResult,
  AutomationAttentionConfirmationResult,
  AutomationAttentionDashboard,
  McpConnectionCheckResult
} from '../../shared/types'

interface AutomationApiModalProps {
  open: boolean
  onClose: () => void
}

export function AutomationApiModal({ open, onClose }: AutomationApiModalProps) {
  const [status, setStatus] = useState<AutomationApiStatus>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mcpChecking, setMcpChecking] = useState(false)
  const [mcpCheck, setMcpCheck] = useState<McpConnectionCheckResult>()
  const [attentionLoading, setAttentionLoading] = useState(false)
  const [attentionRunning, setAttentionRunning] = useState(false)
  const [attentionConfirmingProfileId, setAttentionConfirmingProfileId] = useState<string>()
  const [attentionError, setAttentionError] = useState('')
  const [attentionDashboard, setAttentionDashboard] = useState<AutomationAttentionDashboard>()
  const [attentionAudit, setAttentionAudit] = useState<AutomationAttentionAuditResult>()
  const [attentionConfirmation, setAttentionConfirmation] = useState<AutomationAttentionConfirmationResult>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStatus(await window.browserApi.automation.status())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshAttention = useCallback(async () => {
    setAttentionLoading(true)
    setAttentionError('')
    try {
      setAttentionDashboard(await window.browserApi.automation.attentionDashboard())
    } catch (reason) {
      setAttentionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAttentionLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setMcpCheck(undefined)
      setAttentionAudit(undefined)
      setAttentionConfirmation(undefined)
      void refresh()
      void refreshAttention()
    }
  }, [open, refresh, refreshAttention])

  const runMcpCheck = useCallback(async () => {
    setMcpChecking(true)
    setMcpCheck(undefined)
    try {
      setMcpCheck(await window.browserApi.automation.checkMcp())
    } catch (reason) {
      setMcpCheck({
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        protocolVersion: status?.mcp?.protocolVersion ?? 'unknown',
        toolCount: 0,
        message: reason instanceof Error ? reason.message : String(reason)
      })
    } finally {
      setMcpChecking(false)
    }
  }, [status?.mcp?.protocolVersion])

  const runAttentionAudit = useCallback(async () => {
    setAttentionRunning(true)
    setAttentionError('')
    try {
      const audit = await window.browserApi.automation.runAttentionAudit()
      setAttentionAudit(audit)
      setAttentionDashboard(await window.browserApi.automation.attentionDashboard())
    } catch (reason) {
      setAttentionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAttentionRunning(false)
    }
  }, [])

  const confirmAttentionStep = useCallback((profileId: string, profileName: string, strategyKind: string | undefined, reason: string) => {
    const labels: Record<string, string> = {
      switch_proxy: '切换代理',
      regenerate_identity: '重生成 Identity',
      repair_configuration: '修复配置',
      replace_baseline: '换代 Baseline',
      manual_review: '人工复核'
    }
    const label = strategyKind ? labels[strategyKind] ?? strategyKind : 'Self-Healing'

    if (strategyKind === 'manual_review') {
      Modal.info({
        title: `“${profileName}”需要人工复核`,
        content: (
          <Space direction="vertical" size={6}>
            <Typography.Text>策略：{label}</Typography.Text>
            <Typography.Text type="secondary">{reason}</Typography.Text>
            <Typography.Text type="secondary">该策略没有自动执行动作。请先根据原因检查环境配置或运行时状态，再重新运行安全巡检。</Typography.Text>
          </Space>
        ),
        okText: '知道了'
      })
      return
    }

    Modal.confirm({
      title: `确认处理“${profileName}”？`,
      content: (
        <Space direction="vertical" size={6}>
          <Typography.Text>策略：{label}</Typography.Text>
          <Typography.Text type="secondary">{reason}</Typography.Text>
          <Typography.Text type="secondary">确认后会调用现有 Self-Healing 用户确认链路，执行 Runtime 验证；可回滚策略验证失败时会自动恢复原状态，然后重新计算巡检结果。</Typography.Text>
        </Space>
      ),
      okText: '确认执行并复查',
      cancelText: '取消',
      okButtonProps: { danger: strategyKind === 'switch_proxy' || strategyKind === 'regenerate_identity' },
      onOk: async () => {
        setAttentionConfirmingProfileId(profileId)
        setAttentionError('')
        try {
          const result = await window.browserApi.automation.confirmAttentionStep(profileId, true)
          setAttentionConfirmation(result)
          setAttentionDashboard(await window.browserApi.automation.attentionDashboard())
        } catch (reason) {
          setAttentionError(reason instanceof Error ? reason.message : String(reason))
          throw reason
        } finally {
          setAttentionConfirmingProfileId(undefined)
        }
      }
    })
  }, [])

  return (
    <Modal
      open={open}
      title="自动化 API · MCP"
      width={680}
      onCancel={onClose}
      footer={(
        <Space>
          <Button onClick={() => void refresh()} loading={loading}>刷新状态</Button>
          <Button type="primary" onClick={onClose}>关闭</Button>
        </Space>
      )}
    >
      <Spin spinning={loading && !status}>
        {error && <Alert type="error" showIcon message="无法读取自动化 API 状态" description={error} />}
        {status && (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Alert
              type={status.running ? 'success' : 'warning'}
              showIcon
              message={status.running ? '本机自动化 API 正在运行' : '本机自动化 API 当前未运行'}
              description={status.running
                ? '仅监听 127.0.0.1，并要求 Bearer Token；不会对局域网或公网开放。'
                : '桌面功能仍可使用。请查看日志确认端口占用或 Token 配置。'}
            />
            <div>
              <Typography.Text strong>API 版本：</Typography.Text>
              <Tag>V{status.apiVersion}</Tag>
            </div>
            <div>
              <Typography.Text strong>本机地址：</Typography.Text>{' '}
              <Typography.Text code copyable={status.url ? { text: status.url } : false}>
                {status.url ?? '未监听'}
              </Typography.Text>
            </div>
            <div>
              <Typography.Text strong>Token 文件：</Typography.Text>{' '}
              <Typography.Text code copyable={{ text: status.tokenPath }}>{status.tokenPath}</Typography.Text>
            </div>
            <div>
              <Typography.Text strong>发现文件：</Typography.Text>{' '}
              <Typography.Text code copyable={{ text: status.metadataPath }}>{status.metadataPath}</Typography.Text>
            </div>
            <div>
              <Typography.Text strong>当前能力：</Typography.Text>
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  {status.capabilities.map((capability) => <Tag key={capability}>{capability}</Tag>)}
                </Space>
              </div>
            </div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Token 明文不会显示在 ZBrowser 页面或日志中。脚本、Playwright、Puppeteer 通过本机 Token 文件访问 Local API。
            </Typography.Paragraph>

            <Divider style={{ marginBlock: 4 }} />

            <Typography.Title level={5} style={{ margin: 0 }}>AI 多环境巡检</Typography.Title>
            {attentionError && (
              <Alert
                type="error"
                showIcon
                message="无法读取巡检状态"
                description={attentionError}
              />
            )}
            <Spin spinning={attentionLoading && !attentionDashboard}>
              {attentionDashboard && (
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Alert
                    type={attentionDashboard.plan.count === 0 ? 'success' : attentionDashboard.insights.criticalCount > 0 ? 'error' : 'warning'}
                    showIcon
                    message={attentionDashboard.plan.count === 0
                      ? '当前没有需要处理的环境'
                      : `当前有 ${attentionDashboard.plan.count} 个环境需要处理`}
                    description={attentionDashboard.plan.count === 0
                      ? '巡检队列为空；后续出现进程异常、Identity Health 风险或 Self-Healing 待处理项时会自动进入队列。'
                      : `长期异常 ${attentionDashboard.insights.count} 个 · 待人工确认 ${attentionDashboard.plan.confirmationRequiredCount} 个 · 历史优先 ${attentionDashboard.plan.recurringPriorityCount} 个`}
                  />
                  <Space wrap>
                    <Button
                      type="primary"
                      loading={attentionRunning}
                      onClick={() => void runAttentionAudit()}
                    >
                      运行安全巡检
                    </Button>
                    <Button
                      loading={attentionLoading}
                      onClick={() => void refreshAttention()}
                    >
                      刷新巡检视图
                    </Button>
                    <Tag>计划 {attentionDashboard.plan.count}</Tag>
                    <Tag color={attentionDashboard.plan.confirmationRequiredCount ? 'warning' : undefined}>
                      待确认 {attentionDashboard.plan.confirmationRequiredCount}
                    </Tag>
                    <Tag color={attentionDashboard.insights.criticalCount ? 'error' : undefined}>
                      长期异常 {attentionDashboard.insights.count}
                    </Tag>
                  </Space>

                  {attentionAudit && (
                    <Alert
                      type={attentionAudit.review.remainingCount === 0 && attentionAudit.review.newCount === 0 ? 'success' : 'info'}
                      showIcon
                      message="本轮巡检已完成并自动复查"
                      description={`已解决 ${attentionAudit.review.resolvedCount} · 仍存在 ${attentionAudit.review.remainingCount} · 新出现 ${attentionAudit.review.newCount} · 待人工确认 ${attentionAudit.confirmationRequired} · 失败 ${attentionAudit.failed}`}
                    />
                  )}
                  {attentionConfirmation && (
                    <Alert
                      type={attentionConfirmation.status === 'completed' && attentionConfirmation.review.remainingCount === 0 ? 'success' : 'info'}
                      showIcon
                      message={attentionConfirmation.status === 'completed' ? '确认处理已执行并复查' : '确认处理已结束并复查'}
                      description={`${attentionConfirmation.message} · 已解决 ${attentionConfirmation.review.resolvedCount} · 仍存在 ${attentionConfirmation.review.remainingCount} · 新出现 ${attentionConfirmation.review.newCount}`}
                    />
                  )}

                  {attentionDashboard.plan.steps.length > 0 && (
                    <div>
                      <Typography.Text strong>当前处理顺序</Typography.Text>
                      <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
                        {attentionDashboard.plan.steps.slice(0, 5).map((step) => (
                          <div
                            key={step.profileId}
                            style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, padding: '8px 10px' }}
                          >
                            <Space wrap size={6}>
                              <Tag>#{step.priority}</Tag>
                              <Typography.Text strong>{step.serialNumber} · {step.name}</Typography.Text>
                              <Tag color={step.level === 'critical' ? 'error' : 'warning'}>
                                {step.level === 'critical' ? 'Critical' : 'Warning'}
                              </Tag>
                              {step.requiresUserConfirmation && <Tag color="warning">需要确认</Tag>}
                              {step.historyContext && <Tag color={step.historyContext.level === 'critical' ? 'error' : 'processing'}>长期异常</Tag>}
                            </Space>
                            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
                              {step.reason}
                            </Typography.Paragraph>
                            {step.historyContext && (
                              <Typography.Text type="secondary">
                                最近出现 {step.historyContext.appearances} 次 · 失败 {step.historyContext.failures} 次 · 需确认 {step.historyContext.confirmationRequired} 次
                              </Typography.Text>
                            )}
                            {step.requiresUserConfirmation && (
                              <div style={{ marginTop: 8 }}>
                                <Button
                                  size="small"
                                  danger={step.strategyKind === 'switch_proxy' || step.strategyKind === 'regenerate_identity'}
                                  loading={attentionConfirmingProfileId === step.profileId}
                                  disabled={Boolean(attentionConfirmingProfileId && attentionConfirmingProfileId !== step.profileId)}
                                  onClick={() => confirmAttentionStep(step.profileId, step.name, step.strategyKind, step.reason)}
                                >
                                  {step.strategyKind === 'manual_review' ? '查看人工处理说明' : '确认处理'}
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </Space>
                    </div>
                  )}

                  {attentionDashboard.insights.items.length > 0 && (
                    <div>
                      <Typography.Text strong>长期异常信号</Typography.Text>
                      <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
                        {attentionDashboard.insights.items.slice(0, 5).map((item) => (
                          <div key={item.profileId}>
                            <Space wrap size={6}>
                              <Typography.Text>{item.serialNumber} · {item.name}</Typography.Text>
                              <Tag color={item.level === 'critical' ? 'error' : 'warning'}>
                                {item.level === 'critical' ? 'Critical' : 'Warning'}
                              </Tag>
                              {item.identityScore !== undefined && <Tag>Identity {item.identityScore}</Tag>}
                            </Space>
                            <Typography.Paragraph type="secondary" style={{ margin: '2px 0 0' }}>
                              {item.reason}
                            </Typography.Paragraph>
                          </div>
                        ))}
                      </Space>
                    </div>
                  )}

                  {attentionDashboard.history[0] && (
                    <Typography.Text type="secondary">
                      最近巡检：{new Date(attentionDashboard.history[0].completedAt).toLocaleString()} ·
                      完成 {attentionDashboard.history[0].completed} ·
                      待确认 {attentionDashboard.history[0].confirmationRequired} ·
                      失败 {attentionDashboard.history[0].failed}
                    </Typography.Text>
                  )}
                </Space>
              )}
            </Spin>

            <Divider style={{ marginBlock: 4 }} />

            <Typography.Title level={5} style={{ margin: 0 }}>本地 AI · MCP</Typography.Title>
            {status.mcp ? (
              <>
                <Alert
                  type={status.mcp.available ? 'success' : 'warning'}
                  showIcon
                  message={status.mcp.available ? 'MCP stdio 已准备好' : 'MCP 后端可启动，但当前 Local API 未运行'}
                  description={status.mcp.available
                    ? `支持 MCP ${status.mcp.protocolVersion}，当前提供 ${status.mcp.toolCount} 个本地工具。可运行下面的真实连接自检确认当前安装包可被 AI 客户端拉起。`
                    : 'MCP stdio 依赖正在运行的 ZBrowser Local API。先解决上方 Local API 状态后再连接 AI 客户端。'}
                />
                <Space wrap>
                  <Button
                    type="primary"
                    loading={mcpChecking}
                    disabled={!status.mcp.available}
                    onClick={() => void runMcpCheck()}
                  >
                    运行 MCP 自检
                  </Button>
                  {mcpCheck && (
                    <Tag color={mcpCheck.ok ? 'success' : 'error'}>
                      {mcpCheck.ok ? '连接通过' : '连接失败'}
                    </Tag>
                  )}
                </Space>
                {mcpCheck && (
                  <Alert
                    type={mcpCheck.ok ? 'success' : 'error'}
                    showIcon
                    message={mcpCheck.message}
                    description={mcpCheck.ok
                      ? `服务 ${mcpCheck.serverName ?? 'unknown'} ${mcpCheck.serverVersion ?? ''} · 协议 ${mcpCheck.protocolVersion} · 工具 ${mcpCheck.toolCount} 个 · ${mcpCheck.latencyMs} ms`
                      : `协议 ${mcpCheck.protocolVersion} · ${mcpCheck.latencyMs} ms · 请确认 ZBrowser 主程序仍在运行，并检查 Local API 状态。`}
                  />
                )}
                <div>
                  <Typography.Text strong>传输方式：</Typography.Text>{' '}
                  <Tag>STDIO</Tag>
                </div>
                <div>
                  <Typography.Text strong>启动命令：</Typography.Text>
                  <Typography.Paragraph
                    code
                    copyable={{ text: [status.mcp.command, ...status.mcp.args].map((value) => value.includes(' ') ? `"${value}"` : value).join(' ') }}
                    style={{ marginTop: 6, marginBottom: 8 }}
                  >
                    {[status.mcp.command, ...status.mcp.args].map((value) => value.includes(' ') ? `"${value}"` : value).join(' ')}
                  </Typography.Paragraph>
                </div>
                <div>
                  <Typography.Text strong>MCP 客户端配置：</Typography.Text>
                  <Typography.Paragraph
                    code
                    copyable={{
                      text: JSON.stringify({
                        mcpServers: {
                          zbrowser: {
                            command: status.mcp.command,
                            args: status.mcp.args,
                            ...(status.mcp.env ? { env: status.mcp.env } : {})
                          }
                        }
                      }, null, 2)
                    }}
                    style={{ whiteSpace: 'pre-wrap', marginTop: 6, marginBottom: 0 }}
                  >
                    {JSON.stringify({
                      mcpServers: {
                        zbrowser: {
                          command: status.mcp.command,
                          args: status.mcp.args,
                          ...(status.mcp.env ? { env: status.mcp.env } : {})
                        }
                      }
                    }, null, 2)}
                  </Typography.Paragraph>
                </div>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  MCP 不会把 Local API Token 暴露给模型；子进程只从本机受保护文件读取 Token，并只连接 127.0.0.1。
                </Typography.Paragraph>
              </>
            ) : (
              <Alert type="warning" showIcon message="当前版本未返回 MCP 配置" />
            )}
          </Space>
        )}
      </Spin>
    </Modal>
  )
}
