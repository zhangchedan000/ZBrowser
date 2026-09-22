import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SwapOutlined
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
  type TableColumnsType
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type {
  BrowserProfileView,
  ProxyPoolEntry,
  ProxyPoolEntryInput,
  ProxyProtocol
} from '../../shared/types'

interface Props {
  open: boolean
  profiles: BrowserProfileView[]
  onClose: () => void
  onProfileChanged: (profile: BrowserProfileView) => void
}

interface ProxyFormValues {
  name: string
  tags: string[]
  proxy: {
    protocol: Exclude<ProxyProtocol, 'direct'>
    host: string
    port?: number
    username: string
    password: string
    passwordStored?: boolean
  }
}

const healthLabel: Record<ProxyPoolEntry['health'], { color: string; text: string }> = {
  unchecked: { color: 'default', text: '未检测' },
  healthy: { color: 'success', text: '健康' },
  degraded: { color: 'warning', text: '降级' },
  failed: { color: 'error', text: '失败' },
  quarantined: { color: 'volcano', text: '已隔离' }
}

function humanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function ProxyPoolModal({ open, profiles, onClose, onProfileChanged }: Props) {
  const [entries, setEntries] = useState<ProxyPoolEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [testingAll, setTestingAll] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<ProxyPoolEntry>()
  const [editorOpen, setEditorOpen] = useState(false)
  const [assigningEntry, setAssigningEntry] = useState<ProxyPoolEntry>()
  const [assignProfileId, setAssignProfileId] = useState<string>()
  const [assignBusy, setAssignBusy] = useState(false)
  const [temporaryProfileId, setTemporaryProfileId] = useState<string>()
  const [form] = Form.useForm<ProxyFormValues>()
  const [messageApi, contextHolder] = message.useMessage()

  const temporaryProfiles = useMemo(
    () => profiles.filter((profile) => (profile.environmentType ?? 'account') === 'temporary'),
    [profiles]
  )

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      setEntries(await window.browserApi.proxyPool.list())
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open])

  function openEditor(entry?: ProxyPoolEntry): void {
    setEditing(entry)
    form.setFieldsValue(entry ? {
      name: entry.name,
      tags: [...entry.tags],
      proxy: {
        protocol: entry.proxy.protocol === 'direct' ? 'http' : entry.proxy.protocol,
        host: entry.proxy.host,
        port: entry.proxy.port,
        username: entry.proxy.username,
        password: '',
        passwordStored: entry.proxy.passwordStored
      }
    } : {
      name: '',
      tags: [],
      proxy: { protocol: 'http', host: '', port: 8080, username: '', password: '', passwordStored: false }
    })
    setEditorOpen(true)
  }

  async function save(): Promise<void> {
    try {
      const values = await form.validateFields()
      const input: ProxyPoolEntryInput = {
        name: values.name,
        tags: values.tags ?? [],
        proxy: values.proxy
      }
      if (editing) await window.browserApi.proxyPool.update(editing.id, input)
      else await window.browserApi.proxyPool.create(input)
      setEditorOpen(false)
      setEditing(undefined)
      await refresh()
      messageApi.success(editing ? '代理已更新' : '代理已加入代理池')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) messageApi.error(humanError(error))
    }
  }

  async function testOne(id: string): Promise<void> {
    setBusyIds((current) => new Set(current).add(id))
    try {
      const next = await window.browserApi.proxyPool.test(id)
      setEntries((current) => current.map((entry) => entry.id === id ? next : entry))
    } catch (error) {
      messageApi.error(humanError(error))
    } finally {
      setBusyIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  async function testAll(): Promise<void> {
    setTestingAll(true)
    try {
      setEntries(await window.browserApi.proxyPool.testMany())
      messageApi.success('代理池批量检测完成')
    } catch (error) {
      messageApi.error(humanError(error))
      await refresh()
    } finally {
      setTestingAll(false)
    }
  }

  async function remove(entry: ProxyPoolEntry): Promise<void> {
    try {
      await window.browserApi.proxyPool.remove(entry.id)
      setEntries((current) => current.filter((item) => item.id !== entry.id))
      messageApi.success('代理已删除')
    } catch (error) {
      messageApi.error(humanError(error))
    }
  }

  async function assign(): Promise<void> {
    if (!assigningEntry || !assignProfileId) return
    setAssignBusy(true)
    try {
      const profile = await window.browserApi.proxyPool.assign(assigningEntry.id, assignProfileId)
      onProfileChanged(profile)
      setAssigningEntry(undefined)
      setAssignProfileId(undefined)
      await refresh()
      messageApi.success('代理已分配，并重新匹配网络身份')
    } catch (error) {
      messageApi.error(humanError(error), 8)
    } finally {
      setAssignBusy(false)
    }
  }

  async function assignBestTemporary(): Promise<void> {
    if (!temporaryProfileId) return
    setAssignBusy(true)
    try {
      const profile = await window.browserApi.proxyPool.assignBest(temporaryProfileId)
      onProfileChanged(profile)
      await refresh()
      messageApi.success('已为临时环境选择当前最佳代理')
    } catch (error) {
      messageApi.error(humanError(error), 8)
    } finally {
      setAssignBusy(false)
    }
  }

  const columns: TableColumnsType<ProxyPoolEntry> = [
    {
      title: '代理',
      width: 220,
      render: (_value, entry) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{entry.name}</Typography.Text>
          <Typography.Text type="secondary">
            {entry.proxy.protocol.toUpperCase()} · {entry.proxy.host}:{entry.proxy.port}
          </Typography.Text>
          <Space size={2} wrap>{entry.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space>
        </Space>
      )
    },
    {
      title: '健康',
      width: 125,
      render: (_value, entry) => {
        const health = healthLabel[entry.health]
        return (
          <Space direction="vertical" size={2}>
            <Tag color={health.color}>{health.text}</Tag>
            <Typography.Text type="secondary">评分 {entry.score}/100</Typography.Text>
          </Space>
        )
      }
    },
    {
      title: '出口',
      width: 250,
      render: (_value, entry) => entry.check?.ok ? (
        <Space direction="vertical" size={2}>
          <Typography.Text>{entry.check.ip}</Typography.Text>
          <Typography.Text type="secondary">
            {[entry.check.countryCode, entry.check.city, entry.check.isp || entry.check.organization].filter(Boolean).join(' · ') || '地理信息未完整返回'}
          </Typography.Text>
          <Typography.Text type="secondary">{entry.check.latencyMs} ms</Typography.Text>
        </Space>
      ) : <Typography.Text type="secondary">{entry.check?.error ?? '尚未检测'}</Typography.Text>
    },
    {
      title: '稳定性',
      width: 150,
      render: (_value, entry) => (
        <Space direction="vertical" size={2}>
          <Typography.Text>成功率 {Math.round(entry.stats.successRate * 100)}%</Typography.Text>
          <Typography.Text type="secondary">
            {entry.stats.checks} 次 · 连续失败 {entry.stats.consecutiveFailures}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: '绑定',
      width: 170,
      render: (_value, entry) => {
        const bound = entry.assignedProfileIds
          .map((id) => profiles.find((profile) => profile.id === id))
          .filter((profile): profile is BrowserProfileView => Boolean(profile))
        return bound.length
          ? <Space direction="vertical" size={2}>{bound.map((profile) => (
              <Tag key={profile.id} color={(profile.environmentType ?? 'account') === 'account' ? 'blue' : 'gold'}>
                #{profile.serialNumber} {profile.name}
              </Tag>
            ))}</Space>
          : <Typography.Text type="secondary">未绑定</Typography.Text>
      }
    },
    {
      title: '操作',
      width: 260,
      fixed: 'right',
      render: (_value, entry) => (
        <Space wrap>
          <Button size="small" icon={<ReloadOutlined />} loading={busyIds.has(entry.id)} onClick={() => void testOne(entry.id)}>检测</Button>
          <Button
            size="small"
            type="primary"
            icon={<SwapOutlined />}
            disabled={!['healthy', 'degraded'].includes(entry.health)}
            onClick={() => {
              setAssigningEntry(entry)
              setAssignProfileId(undefined)
            }}
          >
            分配
          </Button>
          <Button size="small" icon={<EditOutlined />} disabled={entry.assignedProfileIds.length > 0} onClick={() => openEditor(entry)}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={entry.assignedProfileIds.length > 0} onClick={() => void remove(entry)}>删除</Button>
        </Space>
      )
    }
  ]

  return (
    <>
      {contextHolder}
      <Modal
        open={open}
        title="代理池"
        width={1180}
        footer={null}
        onCancel={onClose}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          icon={<SafetyCertificateOutlined />}
          title="账号环境默认一号一代理"
          description="账号环境不会自动选择、自动切换或自动替换代理；代理失效或出口变化时会阻止/隔离并报警，由你手动决定换哪个。系统同时检查代理配置和实际出口 IP，避免两个账号环境共用同一出口。临时环境才允许显式使用最佳代理/轮换工具。"
        />
        <Space wrap style={{ margin: '14px 0' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新增代理</Button>
          <Button icon={<ReloadOutlined />} loading={testingAll} onClick={() => void testAll()}>检测全部</Button>
          <Select
            allowClear
            style={{ width: 260 }}
            placeholder="选择临时环境"
            value={temporaryProfileId}
            onChange={setTemporaryProfileId}
            options={temporaryProfiles.map((profile) => ({
              value: profile.id,
              label: `#${profile.serialNumber} · ${profile.name}`
            }))}
          />
          <Button
            icon={<SwapOutlined />}
            disabled={!temporaryProfileId}
            loading={assignBusy}
            onClick={() => void assignBestTemporary()}
          >
            临时环境选最佳代理
          </Button>
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={entries}
          columns={columns}
          pagination={entries.length > 10 ? { pageSize: 10 } : false}
          scroll={{ x: 1175 }}
        />
      </Modal>

      <Modal
        open={editorOpen}
        title={editing ? '编辑代理' : '新增代理'}
        okText="保存"
        cancelText="取消"
        onOk={() => void save()}
        onCancel={() => {
          setEditorOpen(false)
          setEditing(undefined)
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="代理名称" rules={[{ required: true, message: '请输入代理名称' }]}>
            <Input maxLength={80} placeholder="例如：美国住宅 IP 01" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" maxCount={20} tokenSeparators={[',']} placeholder="例如：美国、店铺、静态" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name={['proxy', 'protocol']} label="协议" style={{ width: 130 }} rules={[{ required: true }]}>
              <Select options={[
                { value: 'http', label: 'HTTP' },
                { value: 'https', label: 'HTTPS' },
                { value: 'socks5', label: 'SOCKS5' }
              ]} />
            </Form.Item>
            <Form.Item name={['proxy', 'host']} label="主机" style={{ flex: 1 }} rules={[{ required: true, message: '请输入代理主机' }]}>
              <Input placeholder="proxy.example.com" />
            </Form.Item>
            <Form.Item name={['proxy', 'port']} label="端口" style={{ width: 130 }} rules={[{ required: true, message: '请输入端口' }]}>
              <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name={['proxy', 'username']} label="用户名">
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name={['proxy', 'password']}
            label="密码"
            extra={editing?.proxy.passwordStored ? '已保存密码；留空表示保持不变。' : undefined}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name={['proxy', 'passwordStored']} hidden><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(assigningEntry)}
        title={assigningEntry ? `分配代理：${assigningEntry.name}` : '分配代理'}
        okText="确认分配"
        cancelText="取消"
        confirmLoading={assignBusy}
        okButtonProps={{ disabled: !assignProfileId }}
        onOk={() => void assign()}
        onCancel={() => {
          setAssigningEntry(undefined)
          setAssignProfileId(undefined)
        }}
      >
        <Typography.Paragraph type="secondary">
          更换代理后会立即使用该代理最近一次检测结果重新匹配时区、语言、Accept-Language、WebRTC 与地理位置。账号环境不会自动切换。
        </Typography.Paragraph>
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="选择要绑定的环境"
          value={assignProfileId}
          onChange={setAssignProfileId}
          optionFilterProp="label"
          options={profiles.map((profile) => ({
            value: profile.id,
            label: `#${profile.serialNumber} · ${profile.name} · ${(profile.environmentType ?? 'account') === 'account' ? '账号环境' : '临时环境'}`,
            disabled: !['closed', 'error'].includes(profile.status)
          }))}
        />
      </Modal>
    </>
  )
}
