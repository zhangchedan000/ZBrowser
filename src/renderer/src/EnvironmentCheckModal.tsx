import { Alert, Button, Checkbox, Divider, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import { DeleteOutlined, GlobalOutlined, HistoryOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, EngineStatus, EnvironmentCheckRecord, FingerprintRuntimeDiagnosticReport } from '../../shared/types'
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

function historyChanges(current: EnvironmentCheckRecord, previous?: EnvironmentCheckRecord): string[] {
  if (!previous) return []
  const changes: string[] = []
  if (current.proxyIp && previous.proxyIp && current.proxyIp !== previous.proxyIp) changes.push('出口 IP 变化')
  if (current.timezone !== previous.timezone) changes.push('时区变化')
  if (current.language !== previous.language) changes.push('语言变化')
  if (current.seed !== previous.seed) changes.push('Seed 变化')
  if (current.kernelVersion !== previous.kernelVersion) changes.push('内核变化')
  if (current.hardwareProfileId !== previous.hardwareProfileId) changes.push('硬件模板变化')
  return changes
}

export function EnvironmentCheckModal({ open, profile, engine, busy, onClose, onLaunchChecks }: EnvironmentCheckModalProps) {
  const [selected, setSelected] = useState<string[]>(CHECK_SITES.map((item) => item.key))
  const [history, setHistory] = useState<EnvironmentCheckRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [runtimeReport, setRuntimeReport] = useState<FingerprintRuntimeDiagnosticReport | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const items = useMemo(() => profile ? buildEnvironmentChecks(profile, engine) : [], [profile, engine])
  const summary = useMemo(() => environmentCheckSummary(items), [items])
  const canLaunch = Boolean(profile && (profile.status === 'closed' || profile.status === 'error'))

  useEffect(() => {
    if (!open || !profile) {
      setHistory([])
      setRuntimeReport(null)
      return
    }
    setRuntimeReport(null)
    let active = true
    setHistoryLoading(true)
    void window.browserApi.profiles.environmentCheckHistory(profile.id)
      .then((records) => { if (active) setHistory(records) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [open, profile?.id])

  async function runRuntimeDetection(): Promise<void> {
    if (!profile) return
    setRuntimeLoading(true)
    try {
      setRuntimeReport(await window.browserApi.profiles.diagnoseFingerprintRuntime(profile.id))
    } finally {
      setRuntimeLoading(false)
    }
  }

  async function launch(): Promise<void> {
    if (!profile) return
    const urls = CHECK_SITES.filter((site) => selected.includes(site.key)).map((site) => site.url)
    if (!urls.length) return
    await onLaunchChecks(profile, urls)
    setHistory(await window.browserApi.profiles.recordEnvironmentCheck(profile.id, urls))
  }

  function clearHistory(): void {
    if (!profile || !history.length) return
    Modal.confirm({
      title: '清空这个环境的检测记录？',
      content: '只会删除 ZBrowser 本地保存的检测快照，不会删除浏览器数据、Cookie 或第三方网站数据。',
      okText: '清空记录',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.browserApi.profiles.clearEnvironmentCheckHistory(profile.id)
        setHistory([])
      }
    })
  }

  return (
    <Modal
      open={open}
      title={profile ? `#${profile.serialNumber} ${profile.name} · 环境检测` : '环境检测'}
      width={800}
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

          <Divider style={{ margin: '4px 0' }}>浏览器实际指纹检测</Divider>

          <Space wrap>
            <Button
              type="primary"
              loading={runtimeLoading}
              disabled={!canLaunch || busy}
              onClick={() => void runRuntimeDetection()}
            >
              启动并读取实际指纹
            </Button>
            <Typography.Text type="secondary">
              临时无界面启动当前 Profile，通过本地安全控制管道读取真实 navigator、screen、UA-CH、语言和时区，完成后自动关闭。
            </Typography.Text>
          </Space>

          {runtimeReport && (
            <>
              <Alert
                type={runtimeReport.ready ? 'success' : 'error'}
                showIcon
                message={runtimeReport.ready ? '浏览器实际指纹与当前配置一致' : '浏览器实际指纹检测发现冲突'}
                description={`实际检查 ${runtimeReport.checks.length} 项 · ${new Date(runtimeReport.checkedAt).toLocaleString()}`}
              />
              {runtimeReport.snapshot && (
                <Space wrap size={[12, 4]}>
                  <Tag>{runtimeReport.snapshot.platform}</Tag>
                  <Tag>{runtimeReport.snapshot.hardwareConcurrency} 核</Tag>
                  <Tag>deviceMemory {runtimeReport.snapshot.deviceMemory ?? '-'}GB</Tag>
                  <Tag>DPR {runtimeReport.snapshot.devicePixelRatio}</Tag>
                  <Tag>{runtimeReport.snapshot.screen.width}×{runtimeReport.snapshot.screen.height}</Tag>
                  <Tag>{runtimeReport.snapshot.language}</Tag>
                  <Tag>{runtimeReport.snapshot.timezone}</Tag>
                </Space>
              )}
              <List
                size="small"
                bordered
                dataSource={runtimeReport.checks}
                renderItem={(check) => {
                  const meta = check.status === 'pass'
                    ? { color: 'success', label: '通过' }
                    : check.status === 'warning'
                      ? { color: 'warning', label: '注意' }
                      : { color: 'error', label: '冲突' }
                  return (
                    <List.Item>
                      <List.Item.Meta
                        title={<Space><Typography.Text strong>{check.label}</Typography.Text><Tag color={meta.color}>{meta.label}</Tag></Space>}
                        description={check.message}
                      />
                    </List.Item>
                  )
                }}
              />
            </>
          )}

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
            检测页只会在当前 Profile 中打开，不会修改该环境原本保存的启动页面。检测成功启动后会在本机保存一条配置快照。
          </Typography.Text>

          <Divider style={{ margin: '4px 0' }}>
            <Space><HistoryOutlined />检测历史</Space>
          </Divider>

          <Spin spinning={historyLoading}>
            {history.length ? (
              <>
                <List
                  size="small"
                  bordered
                  dataSource={history.slice(0, 10)}
                  renderItem={(record, index) => {
                    const changes = historyChanges(record, history[index + 1])
                    return (
                      <List.Item>
                        <List.Item.Meta
                          title={
                            <Space wrap>
                              <Typography.Text strong>{new Date(record.checkedAt).toLocaleString()}</Typography.Text>
                              {record.localSummary.errors > 0
                                ? <Tag color="error">{record.localSummary.errors} 冲突</Tag>
                                : record.localSummary.warnings > 0
                                  ? <Tag color="warning">{record.localSummary.warnings} 注意</Tag>
                                  : <Tag color="success">本地检查正常</Tag>}
                              {changes.map((change) => <Tag key={change} color="processing">{change}</Tag>)}
                            </Space>
                          }
                          description={
                            <Space wrap size={[12, 4]}>
                              <span>IP {record.proxyIp ?? '直连/未检测'}</span>
                              <span>{record.countryCode ?? '-'}</span>
                              <span>{record.timezone}</span>
                              <span>{record.language}</span>
                              <span>Seed {record.seed}</span>
                              <span>内核 {record.kernelVersion ?? '自动'}</span>
                              <span>{record.screenWidth}×{record.screenHeight}</span>
                            </Space>
                          }
                        />
                      </List.Item>
                    )
                  }}
                />
                <Space style={{ marginTop: 10 }}>
                  <Typography.Text type="secondary">最多保留最近 50 条，本页显示最近 10 条。</Typography.Text>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={clearHistory}>清空记录</Button>
                </Space>
              </>
            ) : (
              <Typography.Text type="secondary">还没有检测记录。打开检测页后会自动保存本地配置快照。</Typography.Text>
            )}
          </Spin>
        </Space>
      )}
    </Modal>
  )
}
