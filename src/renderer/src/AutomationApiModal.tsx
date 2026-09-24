import { Alert, Button, Divider, Modal, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type { AutomationApiStatus, McpConnectionCheckResult } from '../../shared/types'

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

  useEffect(() => {
    if (open) {
      setMcpCheck(undefined)
      void refresh()
    }
  }, [open, refresh])

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
                            args: status.mcp.args
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
                          args: status.mcp.args
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
