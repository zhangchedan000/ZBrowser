import { CheckCircleFilled, CloudDownloadOutlined, DeleteOutlined, FolderOpenOutlined, ReloadOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons'
import { Alert, Button, List, Modal, Popconfirm, Progress, Space, Spin, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EngineStatus, KernelHealth, KernelInstallProgress, KernelRelease } from '../../shared/types'

interface KernelManagerModalProps {
  open: boolean
  engine: EngineStatus | null
  onClose: () => void
  onEngineChanged: (engine: EngineStatus) => void
}

function sizeLabel(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
}

const RECOMMENDED_KERNEL = '144.0.7559.132'

function compatibilityLabel(version: string): { color: string; text: string; detail?: string } {
  if (version === RECOMMENDED_KERNEL) {
    return { color: 'success', text: '推荐兼容', detail: '当前 ZBrowser 指纹参数与 GPU 模板已按此版本验证。' }
  }
  const major = Number(version.split('.')[0])
  if (Number.isFinite(major) && major > 144) {
    return { color: 'warning', text: '新版实验', detail: '上游指纹实现可能变化，建议先新建测试环境并跑完整环境检测。' }
  }
  return { color: 'default', text: '兼容待验证' }
}

export function KernelManagerModal({ open, engine, onClose, onEngineChanged }: KernelManagerModalProps) {
  const [releases, setReleases] = useState<KernelRelease[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState<KernelInstallProgress | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [health, setHealth] = useState<Record<string, KernelHealth>>({})
  const [bundled, setBundled] = useState<EngineStatus | null>(null)
  const [rollbackAvailable, setRollbackAvailable] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()

  const currentVersion = useMemo(
    () => releases.find((release) => release.executable && release.executable === engine?.executable)?.version,
    [engine?.executable, releases]
  )

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [items, bundledEngine, canRollback] = await Promise.all([
        window.browserApi.engine.releases(),
        window.browserApi.engine.bundled(),
        window.browserApi.engine.rollbackAvailable()
      ])
      setReleases(items)
      setBundled(bundledEngine)
      setRollbackAvailable(canRollback)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    return window.browserApi.engine.onInstallProgress((progress) => {
      setInstallProgress(progress)
      if (progress.stage === 'ready' || progress.stage === 'cancelled' || progress.stage === 'error') {
        setTimeout(() => setInstallProgress((current) => current?.version === progress.version ? null : current), 1500)
      }
    })
  }, [open])

  async function install(version: string): Promise<void> {
    const compatibility = compatibilityLabel(version)
    if (compatibility.text === '新版实验') {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: `安装实验内核 ${version}？`,
          content: '该版本来自可信开源发行源，但 ZBrowser 当前的指纹模板主要按 Chromium 144 验证。建议只在测试环境中使用，并重新跑 BrowserLeaks / Pixelscan / CreepJS。',
          okText: '继续安装',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })
      if (!confirmed) return
    }
    setInstalling(version)
    setInstallProgress({
      version,
      stage: 'downloading',
      receivedBytes: 0,
      totalBytes: 0,
      percent: 0,
      message: '正在准备下载…'
    })
    try {
      const status = await window.browserApi.engine.install(version)
      onEngineChanged(status)
      await refresh()
      messageApi.success(`Fingerprint Chromium ${version} 已安装并启用`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setInstalling(null)
      setInstallProgress((current) => current?.version === version && current.stage !== 'error' ? null : current)
    }
  }

  async function cancelInstall(version: string): Promise<void> {
    try {
      await window.browserApi.engine.cancelInstall(version)
      messageApi.info('已请求取消内核下载')
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function activate(version: string): Promise<void> {
    try {
      onEngineChanged(await window.browserApi.engine.activate(version))
      messageApi.success(`已切换到内核 ${version}`)
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function selectManual(): Promise<void> {
    try {
      const status = await window.browserApi.engine.select()
      onEngineChanged(status)
      if (status.fingerprintKernel) messageApi.success('自定义指纹内核已启用')
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function activateBundled(): Promise<void> {
    try {
      onEngineChanged(await window.browserApi.engine.activateBundled())
      messageApi.success(`已启用内置内核 ${bundled?.version ?? ''}`)
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function useSystem(): Promise<void> {
    try {
      onEngineChanged(await window.browserApi.engine.useSystem())
      messageApi.success('已切换到系统浏览器兼容模式')
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function rollback(): Promise<void> {
    try {
      const status = await window.browserApi.engine.rollback()
      onEngineChanged(status)
      setRollbackAvailable(false)
      await refresh()
      messageApi.success(`已回滚到 ${status.version ?? status.label}`)
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function importLocal(): Promise<void> {
    try {
      const status = await window.browserApi.engine.importLocal()
      onEngineChanged(status)
      await refresh()
      if (status.fingerprintKernel) messageApi.success(`本地构建 ${status.version ?? ''} 已导入并启用`)
    } catch (error) {
      messageApi.error(errorText(error))
    }
  }

  async function remove(version: string): Promise<void> {
    setRemoving(version)
    try {
      await window.browserApi.engine.remove(version)
      await refresh()
      onEngineChanged(await window.browserApi.engine.status())
      messageApi.success(`内核 ${version} 已移入回收目录`)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setRemoving(null)
    }
  }

  async function verify(version: string): Promise<void> {
    setVerifying(version)
    try {
      const result = await window.browserApi.engine.verify(version)
      setHealth((current) => ({ ...current, [version]: result }))
      if (result.status === 'healthy') messageApi.success(`内核 ${version} 检查通过`)
      else messageApi.warning(result.message)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setVerifying(null)
    }
  }

  return (
    <Modal open={open} title="浏览器内核" width={800} footer={null} onCancel={onClose} destroyOnHidden>
      {contextHolder}
      <Alert
        className="kernel-notice"
        type="info"
        showIcon
        title="可直接安装开源 Fingerprint Chromium"
        description="发行包直接来自 adryfish/fingerprint-chromium 的 GitHub Releases。ZBrowser 会校验 GitHub 提供的 SHA-256 后再安装；无需 Prism Pro。"
      />

      <div className="kernel-toolbar">
        <div>
          <Typography.Text strong>Fingerprint Chromium</Typography.Text>
          <Typography.Text type="secondary">当前：{engine?.label ?? '未配置'}{engine?.version ? ` · ${engine.version}` : ''}</Typography.Text>
        </div>
        <Space wrap>
          {bundled?.executable && engine?.executable !== bundled.executable && (
            <Button type="primary" onClick={() => void activateBundled()}>使用内置 {bundled.version}</Button>
          )}
          <Button icon={<FolderOpenOutlined />} onClick={() => void importLocal()}>导入本地构建</Button>
          <Button onClick={() => void selectManual()}>外部路径</Button>
          <Button onClick={() => void useSystem()}>系统兼容模式</Button>
          {rollbackAvailable && (
            <Popconfirm
              title="回滚到上一个健康内核？"
              description="请先关闭全部浏览器环境。"
              onConfirm={() => rollback()}
            >
              <Button danger>回滚上一个</Button>
            </Popconfirm>
          )}
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新版本</Button>
        </Space>
      </div>

      <Spin spinning={loading && releases.length === 0}>
        <List
          className="kernel-list"
          dataSource={releases}
          locale={{ emptyText: '暂时没有找到可用的开源内核版本' }}
          renderItem={(release) => {
            const active = currentVersion === release.version
            const bundledRelease = release.origin === 'bundled'
            const compatibility = compatibilityLabel(release.version)
            const actions: ReactNode[] = []

            if (!release.installed && release.remoteAvailable) {
              if (installing === release.version) {
                actions.push(
                  <Button key="cancel" danger icon={<StopOutlined />} onClick={() => void cancelInstall(release.version)}>
                    取消下载
                  </Button>
                )
              } else {
                actions.push(
                  <Button
                    key="install"
                    type="primary"
                    icon={<CloudDownloadOutlined />}
                    disabled={Boolean(installing)}
                    onClick={() => void install(release.version)}
                  >
                    下载并安装
                  </Button>
                )
              }
            } else if (release.installed) {
              actions.push(
                active
                  ? <Tag key="active" color="success" icon={<CheckCircleFilled />}>正在使用</Tag>
                  : <Button key="use" disabled={Boolean(installing)} onClick={() => void activate(release.version)}>切换使用</Button>
              )
            }

            if (release.installed && !active && !bundledRelease) {
              actions.push(
                <Popconfirm
                  key="remove"
                  title={`移除内核 ${release.version}？`}
                  description="文件会移动到本机回收目录。"
                  okText="移除"
                  cancelText="取消"
                  onConfirm={() => remove(release.version)}
                >
                  <Button danger type="text" icon={<DeleteOutlined />} loading={removing === release.version}>移除</Button>
                </Popconfirm>
              )
            }
            if (release.installed) {
              actions.push(
                <Button
                  key="verify"
                  type="text"
                  icon={<SafetyCertificateOutlined />}
                  loading={verifying === release.version}
                  onClick={() => void verify(release.version)}
                >检查</Button>
              )
            }

            return (
              <List.Item actions={actions}>
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <span>Chromium {release.version}</span>
                      {release.installed && <Tag>已安装</Tag>}
                      {release.remoteAvailable && <Tag color="cyan">开源发行版</Tag>}
                      <Tag color={compatibility.color}>{compatibility.text}</Tag>
                      {bundledRelease && <Tag color="blue">随应用内置</Tag>}
                      {release.origin === 'local-build' && <Tag color="purple">本地构建</Tag>}
                      {health[release.version]?.status === 'healthy' && <Tag color="success">文件正常</Tag>}
                      {health[release.version]?.status === 'unverified' && <Tag color="warning">建议重新导入</Tag>}
                      {health[release.version]?.status === 'corrupt' && <Tag color="error">文件异常</Tag>}
                    </Space>
                  }
                  description={
                    <div className="kernel-meta">
                      <span>{release.size ? sizeLabel(release.size) : '本地安装'}</span>
                      <span>{release.remoteAvailable ? 'GitHub 官方发行资产 · SHA-256 校验' : '仅本地可用'}</span>
                      {compatibility.detail && <span>{compatibility.detail}</span>}
                      {installProgress?.version === release.version && (
                        <div style={{ width: '100%', maxWidth: 420, marginTop: 6 }}>
                          <Progress
                            size="small"
                            percent={Math.max(0, Math.min(100, Math.round(installProgress.percent || 0)))}
                            status={installProgress.stage === 'error' ? 'exception' : installProgress.stage === 'ready' ? 'success' : 'active'}
                          />
                          <Typography.Text type="secondary">{installProgress.message}</Typography.Text>
                        </div>
                      )}
                    </div>
                  }
                />
              </List.Item>
            )
          }}
        />
      </Spin>
    </Modal>
  )
}
