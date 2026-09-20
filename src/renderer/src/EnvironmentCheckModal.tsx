import { Alert, Button, Checkbox, Divider, List, Modal, Space, Tag, Typography } from 'antd'
import { GlobalOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useMemo, useState } from 'react'
import type { BrowserProfileView, EngineStatus } from '../../shared/types'
import { buildEnvironmentChecks, environmentCheckSummary, type EnvironmentCheckLevel } from '../../shared/environment-check'

interface EnvironmentCheckModalProps {
  open: boolean
  profile?: BrowserProfileView
  engine: EngineStatus | null
  busy: boolean
  onClose: () => void
  onLaunchChecks: (profile: BrowserProfileView, urls: string[]) => Promise<void>
}

const CHECK_SITES = [
  { key: 'ip', name: 'BrowserLeaks · IP / DNS', url: 'https://browserleaks.com/ip', note: '出口 IP、DNS、网络信息' },
  { key: 'webrtc', name: 'BrowserLeaks · WebRTC', url: 'https://browserleaks.com/webrtc', note: '检查 WebRTC 地址泄漏' },
  { key: 'canvas', name: 'BrowserLeaks · Canvas', url: 'https://browserleaks.com/canvas', note: '检查 Canvas 指纹' },
  { key: 'pixelscan', name: 'Pixelscan', url: 'https://pixelscan.net/', note: '综合浏览器环境一致性' },
  { key: 'iphey', name: 'IPhey', url: 'https://iphey.com/', note: '综合指纹与网络环境' },
  { key: 'creepjs', name: 'CreepJS', url: 'https://abrahamjuliot.github.io/creepjs/', note: '高级浏览器指纹信息' }
]

const levelMeta: Record<EnvironmentCheckLevel, { color: string; label: string }> = {
  ok: { color: 'success', label: '正常' },
  warning: { color: 'warning', label: '注意' },
  error: { color: 'error', label: '冲突' },
  info: { color: 'default', label: '信息' }
}

export function EnvironmentCheckModal({ open, profile, engine, busy, onClose, onLaunchChecks }: EnvironmentCheckModalProps) {
  const [selected, setSelected] = useState<string[]>(CHECK_SITES.map((item) => item.key))
  const items = useMemo(() => profile ? buildEnvironmentChecks(profile, engine) : [], [profile, engine])
  const summary = useMemo(() => environmentCheckSummary(items), [items])
  const canLaunch = Boolean(profile && (profile.status === 'closed' || profile.status === 'error'))

  async function launch(): Promise<void> {
    if (!profile) return
    const urls = CHECK_SITES.filter((site) => selected.includes(site.key)).map((site) => site.url)
    if (!urls.length) return
    await onLaunchChecks(profile, urls)
  }

  return (
    <Modal
      open={open}
      title={profile ? `#${profile.serialNumber} ${profile.name} · 环境检测` : '环境检测'}
      width={760}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {!profile ? null : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type={summary.errors ? 'error' : summary.warnings ? 'warning' : 'success'}
            showIcon
            icon={<SafetyCertificateOutlined />}
            message={summary.errors
              ? `发现 ${summary.errors} 个明显冲突，建议先修正再打开检测网站`
              : summary.warnings
                ? `本地检查完成：${summary.warnings} 项需要确认`
                : '本地一致性检查未发现明显冲突'}
            description="本地检查用于发现配置层面的明显矛盾；第三方网站检测才是最终浏览器实际环境验证。"
          />

          <List
            size="small"
            bordered
            dataSource={items}
            renderItem={(item) => {
              const meta = levelMeta[item.level]
              return (
                <List.Item>
                  <List.Item.Meta
                    title={<Space><Typography.Text strong>{item.label}</Typography.Text><Tag color={meta.color}>{meta.label}</Tag></Space>}
                    description={<><Typography.Text>{item.summary}</Typography.Text>{item.detail && <><br /><Typography.Text type="secondary">{item.detail}</Typography.Text></>}</>}
                  />
                </List.Item>
              )
            }}
          />

          <Divider style={{ margin: '4px 0' }}>第三方环境检测</Divider>

          {!canLaunch && (
            <Alert
              type="info"
              showIcon
              message="请先关闭当前环境"
              description="为了确保检测网站使用同一个 Profile、同一套代理和指纹参数，环境检测会以检测网址重新启动该 Profile。"
            />
          )}

          <Checkbox.Group value={selected} onChange={(values) => setSelected(values.map(String))} style={{ width: '100%' }}>
            <List
              size="small"
              dataSource={CHECK_SITES}
              renderItem={(site) => (
                <List.Item>
                  <Checkbox value={site.key}>
                    <Typography.Text strong>{site.name}</Typography.Text>
                    <Typography.Text type="secondary"> · {site.note}</Typography.Text>
                  </Checkbox>
                </List.Item>
              )}
            />
          </Checkbox.Group>

          <Space>
            <Button
              type="primary"
              icon={<GlobalOutlined />}
              loading={busy}
              disabled={!canLaunch || !selected.length}
              onClick={() => void launch()}
            >
              用当前环境打开选中检测页
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </Space>
          <Typography.Text type="secondary">
            检测页只会在当前 Profile 中打开，不会修改该环境原本保存的启动页面。
          </Typography.Text>
        </Space>
      )}
    </Modal>
  )
}
