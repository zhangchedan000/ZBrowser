import { Alert, List, Modal, Space, Tag, Typography } from 'antd'

export interface BatchOperationDetail {
  label: string
  status: 'success' | 'failed' | 'skipped'
  message: string
}

export interface BatchOperationResult {
  operation: '启动' | '关闭' | '内核升级'
  total: number
  succeeded: number
  errors: string[]
  skipped?: number
  details?: BatchOperationDetail[]
  paused?: boolean
}

interface BatchResultModalProps {
  result?: BatchOperationResult
  onClose: () => void
}

const statusTag = {
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  skipped: { color: 'default', text: '跳过' }
} as const

export function BatchResultModal({ result, onClose }: BatchResultModalProps) {
  const skipped = result?.skipped ?? 0
  const failed = result?.errors.length ?? 0
  return (
    <Modal open={Boolean(result)} title="批量操作结果" footer={null} onCancel={onClose} destroyOnHidden>
      {result && (
        <>
          <Alert
            type={failed || result.paused ? 'warning' : 'success'}
            showIcon
            title={`批量${result.operation}完成：成功 ${result.succeeded}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}`}
            description={result.paused ? '遇到失败后已按安全规则暂停，后续可升级环境没有继续执行。' : undefined}
          />
          {result.details?.length ? (
            <List
              dataSource={result.details}
              renderItem={(detail) => (
                <List.Item>
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space>
                      <Tag color={statusTag[detail.status].color}>{statusTag[detail.status].text}</Tag>
                      <Typography.Text strong>{detail.label}</Typography.Text>
                    </Space>
                    <Typography.Text type={detail.status === 'failed' ? 'danger' : 'secondary'} copyable={detail.status === 'failed'}>
                      {detail.message}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          ) : result.errors.length > 0 ? (
            <List
              dataSource={result.errors}
              renderItem={(error) => (
                <List.Item>
                  <Typography.Text type="danger" copyable>{error}</Typography.Text>
                </List.Item>
              )}
            />
          ) : null}
        </>
      )}
    </Modal>
  )
}
