import { Alert, Button, Modal, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import type { AutomationApiStatus } from '../../shared/types'

interface AutomationApiModalProps {
  open: boolean
  onClose: () => void
}

export function AutomationApiModal({ open, onClose }: AutomationApiModalProps) {
  const [status, setStatus] = useState<AutomationApiStatus>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
    if (open) void refresh()
  }, [open, refresh])

  return (
    <Modal
      open={open}
      title="自动化 API"
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
              Token 明文不会显示在 ZBrowser 页面或日志中。需要接入脚本、Playwright、Puppeteer 或后续 MCP 时，
              由本机程序读取 Token 文件，并通过 Authorization: Bearer 请求头访问。
            </Typography.Paragraph>
          </Space>
        )}
      </Spin>
    </Modal>
  )
}
