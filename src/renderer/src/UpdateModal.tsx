import { Alert, Button, Modal, Space, Tag, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import type { AppUpdateStatus } from '../../shared/types'

interface UpdateModalProps {
  open: boolean
  appStatus: AppUpdateStatus | null
  onClose: () => void
  onStatusChanged: (status: AppUpdateStatus) => void
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function UpdateModal({ open, appStatus, onClose, onStatusChanged }: UpdateModalProps) {
  const [busy, setBusy] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  async function check(): Promise<void> {
    setBusy(true)
    try {
      onStatusChanged(await window.browserApi.updates.check())
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function download(): Promise<void> {
    setBusy(true)
    try {
      const status = await window.browserApi.updates.download()
      onStatusChanged(status)
      if (status.stage === 'ready') messageApi.success('更新包已准备好')
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function openInstaller(): Promise<void> {
    try {
      await window.browserApi.updates.openInstaller()
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  useEffect(() => {
    if (open) void check()
  }, [open])

  const type = appStatus?.stage === 'error'
    ? 'error'
    : appStatus?.stage === 'available'
      ? 'info'
      : appStatus?.stage === 'ready'
        ? 'success'
        : appStatus?.stage === 'disabled'
          ? 'warning'
          : 'success'

  return (
    <Modal open={open} title="ZBrowser 应用更新" footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            ZBrowser {appStatus?.currentVersion ?? ''}
          </Typography.Title>
          <Space wrap>
            <Tag>当前版本 {appStatus?.currentVersion ?? '未知'}</Tag>
            {appStatus?.latestVersion && <Tag color="blue">可用版本 {appStatus.latestVersion}</Tag>}
          </Space>
        </div>
        <Alert
          showIcon
          type={type}
          title={busy ? '正在检查更新…' : appStatus?.message ?? '更新通道尚未配置'}
          description={appStatus?.stage === 'disabled'
            ? '当前构建未连接 ZBrowser 更新通道；不影响指纹、代理和环境管理功能。'
            : undefined}
        />
        <Space wrap>
          <Button loading={busy} onClick={() => void check()}>重新检查</Button>
          {appStatus?.stage === 'available' && (
            <Button type="primary" loading={busy} onClick={() => void download()}>下载更新</Button>
          )}
          {appStatus?.stage === 'ready' && (
            <Button type="primary" onClick={() => void openInstaller()}>打开安装程序</Button>
          )}
        </Space>
      </Space>
    </Modal>
  )
}
