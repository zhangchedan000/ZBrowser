import { LockOutlined, ReloadOutlined, TeamOutlined, UserAddOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Typography, message, type TableColumnsType } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { BrowserProfileView, TeamAuditEvent, TeamMember, TeamState } from '../../shared/types'

interface TeamManagementModalProps {
  open: boolean
  profiles: BrowserProfileView[]
  onClose: () => void
}

const auditLabels: Record<TeamAuditEvent['type'], string> = {
  team_created: '创建团队',
  member_created: '创建子账号',
  member_updated: '更新子账号',
  member_disabled: '禁用子账号',
  profile_assigned: '分配环境',
  profile_unassigned: '收回环境',
  lease_acquired: '占用环境',
  lease_renewed: '续期占用',
  lease_released: '释放环境',
  lease_force_released: '强制释放环境',
  profile_synced: '同步环境',
  profile_trashed: '环境进入回收站',
  profile_restored: '从回收站恢复环境'
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function TeamManagementModal({ open, profiles, onClose }: TeamManagementModalProps) {
  const [team, setTeam] = useState<TeamState | null>(null)
  const [audit, setAudit] = useState<TeamAuditEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [memberName, setMemberName] = useState('')
  const [messageApi, contextHolder] = message.useMessage()

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [state, events] = await Promise.all([
        window.browserApi.team.state(),
        window.browserApi.team.audit(100)
      ])
      setTeam(state)
      setAudit(events)
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  const membersById = useMemo(
    () => new Map((team?.members ?? []).map((member) => [member.id, member])),
    [team]
  )

  const memberOptions = useMemo(
    () => (team?.members ?? [])
      .filter((member) => member.role === 'member' && member.enabled)
      .map((member) => ({ value: member.id, label: member.name })),
    [team]
  )

  const assignmentByProfile = useMemo(
    () => new Map((team?.assignments ?? []).map((item) => [item.profileId, item])),
    [team]
  )

  const leaseByProfile = useMemo(
    () => new Map((team?.leases ?? []).map((item) => [item.profileId, item])),
    [team]
  )

  const revisionByProfile = useMemo(
    () => new Map((team?.revisions ?? []).map((item) => [item.profileId, item])),
    [team]
  )

  async function createMember(): Promise<void> {
    const name = memberName.trim()
    if (!name) return
    setBusyKey('create-member')
    try {
      await window.browserApi.team.createMember(name)
      setMemberName('')
      await refresh()
      messageApi.success('子账号已创建')
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusyKey('')
    }
  }

  async function setMemberEnabled(member: TeamMember, enabled: boolean): Promise<void> {
    setBusyKey(`member:${member.id}`)
    try {
      await window.browserApi.team.updateMember(member.id, { enabled })
      await refresh()
      messageApi.success(enabled ? '子账号已启用' : '子账号已禁用，已有占用已释放')
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusyKey('')
    }
  }

  async function setAssignment(profileId: string, memberIds: string[]): Promise<void> {
    setBusyKey(`profile:${profileId}`)
    try {
      await window.browserApi.team.setProfileAssignments(profileId, memberIds)
      await refresh()
      messageApi.success(memberIds.length ? '环境分配已更新' : '环境已从全部子账号收回')
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusyKey('')
    }
  }

  async function forceRelease(profileId: string): Promise<void> {
    setBusyKey(`lease:${profileId}`)
    try {
      await window.browserApi.team.forceRelease(profileId)
      await refresh()
      messageApi.success('环境占用已强制释放')
    } catch (error) {
      messageApi.error(errorText(error))
    } finally {
      setBusyKey('')
    }
  }

  const memberColumns: TableColumnsType<TeamMember> = [
    {
      title: '账号',
      dataIndex: 'name',
      render: (name: string, member) => (
        <Space>
          <Typography.Text strong>{name}</Typography.Text>
          {member.role === 'owner' && <Tag color="blue">主账号</Tag>}
        </Space>
      )
    },
    {
      title: '状态',
      width: 110,
      render: (_, member) => <Tag color={member.enabled ? 'green' : 'default'}>{member.enabled ? '启用' : '已禁用'}</Tag>
    },
    {
      title: '权限',
      width: 180,
      render: (_, member) => member.role === 'owner'
        ? '全部管理权限'
        : '仅使用已分配环境'
    },
    {
      title: '操作',
      width: 130,
      render: (_, member) => member.role === 'owner' ? null : (
        <Popconfirm
          title={member.enabled ? '禁用这个子账号？' : '重新启用这个子账号？'}
          description={member.enabled ? '禁用后将立即失去使用权限，并释放该账号当前占用的环境。' : undefined}
          okText={member.enabled ? '禁用' : '启用'}
          cancelText="取消"
          onConfirm={() => void setMemberEnabled(member, !member.enabled)}
        >
          <Button
            danger={member.enabled}
            size="small"
            loading={busyKey === `member:${member.id}`}
          >
            {member.enabled ? '禁用' : '启用'}
          </Button>
        </Popconfirm>
      )
    }
  ]

  const profileColumns: TableColumnsType<BrowserProfileView> = [
    {
      title: '环境',
      width: 210,
      render: (_, profile) => (
        <div>
          <Typography.Text strong>#{profile.serialNumber} · {profile.name}</Typography.Text>
          <br />
          <Typography.Text type="secondary">{profile.group || '未分组'}</Typography.Text>
        </div>
      )
    },
    {
      title: '分配给子账号',
      render: (_, profile) => (
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%', minWidth: 260 }}
          placeholder="未分配"
          options={memberOptions}
          value={assignmentByProfile.get(profile.id)?.memberIds ?? []}
          loading={busyKey === `profile:${profile.id}`}
          disabled={Boolean(busyKey)}
          onChange={(ids) => void setAssignment(profile.id, ids)}
        />
      )
    },
    {
      title: '当前占用',
      width: 180,
      render: (_, profile) => {
        const lease = leaseByProfile.get(profile.id)
        if (!lease) return <Tag>空闲</Tag>
        return (
          <div>
            <Tag color="processing"><LockOutlined /> {membersById.get(lease.memberId)?.name ?? '未知成员'}</Tag>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              到期 {new Date(lease.expiresAt).toLocaleTimeString()}
            </Typography.Text>
          </div>
        )
      }
    },
    {
      title: '版本',
      width: 90,
      render: (_, profile) => `r${revisionByProfile.get(profile.id)?.revision ?? 0}`
    },
    {
      title: '操作',
      width: 110,
      render: (_, profile) => leaseByProfile.has(profile.id) ? (
        <Popconfirm
          title="强制释放这个环境？"
          description="用于设备异常、崩溃或占用未自动释放的情况。"
          okText="强制释放"
          cancelText="取消"
          onConfirm={() => void forceRelease(profile.id)}
        >
          <Button danger size="small" loading={busyKey === `lease:${profile.id}`}>释放</Button>
        </Popconfirm>
      ) : null
    }
  ]

  const auditColumns: TableColumnsType<TeamAuditEvent> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString()
    },
    {
      title: '操作',
      dataIndex: 'type',
      width: 170,
      render: (value: TeamAuditEvent['type']) => auditLabels[value] ?? value
    },
    {
      title: '执行账号',
      dataIndex: 'actorMemberId',
      width: 150,
      render: (id: string) => membersById.get(id)?.name ?? id.slice(0, 8)
    },
    {
      title: '对象',
      render: (_, event) => {
        if (event.profileId) {
          const profile = profiles.find((item) => item.id === event.profileId)
          return profile ? `#${profile.serialNumber} · ${profile.name}` : `环境 ${event.profileId.slice(0, 8)}`
        }
        if (event.targetMemberId) return membersById.get(event.targetMemberId)?.name ?? event.targetMemberId.slice(0, 8)
        return '—'
      }
    }
  ]

  return (
    <Modal
      open={open}
      title={<Space><TeamOutlined />团队与子账号</Space>}
      width={1040}
      footer={<Button onClick={onClose}>关闭</Button>}
      onCancel={onClose}
      destroyOnHidden
    >
      {contextHolder}
      <Alert
        type="info"
        showIcon
        title="主账号统一管理，子账号只使用环境"
        description="一个环境可以分配给多个子账号，但同一时间只允许一个账号运行。删除环境会自动收回全部权限；从回收站恢复后默认保持未分配。"
        style={{ marginBottom: 16 }}
      />
      <Spin spinning={loading}>
        <Tabs
          items={[
            {
              key: 'members',
              label: '子账号',
              children: (
                <Space direction="vertical" size={14} style={{ width: '100%' }}>
                  <Space.Compact style={{ width: 420 }}>
                    <Input
                      value={memberName}
                      maxLength={60}
                      placeholder="输入子账号名称"
                      onPressEnter={() => void createMember()}
                      onChange={(event) => setMemberName(event.target.value)}
                    />
                    <Button
                      type="primary"
                      icon={<UserAddOutlined />}
                      loading={busyKey === 'create-member'}
                      disabled={!memberName.trim()}
                      onClick={() => void createMember()}
                    >
                      创建
                    </Button>
                  </Space.Compact>
                  <Table
                    rowKey="id"
                    size="small"
                    columns={memberColumns}
                    dataSource={team?.members ?? []}
                    pagination={false}
                  />
                </Space>
              )
            },
            {
              key: 'profiles',
              label: '环境分配',
              children: profiles.length ? (
                <Table
                  rowKey="id"
                  size="small"
                  columns={profileColumns}
                  dataSource={profiles}
                  pagination={profiles.length > 10 ? { pageSize: 10 } : false}
                  scroll={{ x: 900 }}
                />
              ) : <Empty description="还没有可以分配的环境" />
            },
            {
              key: 'audit',
              label: '操作日志',
              children: (
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button>
                  <Table
                    rowKey="id"
                    size="small"
                    columns={auditColumns}
                    dataSource={audit}
                    pagination={audit.length > 20 ? { pageSize: 20 } : false}
                  />
                </Space>
              )
            }
          ]}
        />
      </Spin>
    </Modal>
  )
}