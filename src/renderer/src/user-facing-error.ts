export interface UserFacingError {
  title: string
  detail: string
  action?: string
}

export function runtimeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export function explainRuntimeError(error: unknown): UserFacingError {
  const message = runtimeErrorDetail(error)
  const text = message.toLowerCase()

  if (text.includes('permission') || text.includes('owner') || text.includes('权限') || text.includes('主账号') || text.includes('子账号')) {
    return {
      title: '当前账号没有操作权限',
      detail: message,
      action: '请联系主账号重新分配环境或权限。'
    }
  }

  if (
    text.includes('proxy')
    || text.includes('代理')
    || text.includes('timeout')
    || text.includes('timed out')
    || text.includes('net::err_proxy')
    || text.includes('外部网页')
    || text.includes('网络已断开')
  ) {
    return {
      title: '代理或网络连接异常',
      detail: message,
      action: '请检查代理地址、端口、账号密码和节点状态；如果代理检测通过但网页仍打不开，请重新检测实际网页连通性。'
    }
  }

  if (
    text.includes('内核')
    || text.includes('kernel')
    || text.includes('executable')
    || text.includes('browser executable')
    || text.includes('没有找到浏览器')
  ) {
    return {
      title: '浏览器内核无法使用',
      detail: message,
      action: '请打开内核管理，安装、恢复或切换该环境需要的内核后重试。'
    }
  }

  if (
    text.includes('identity')
    || text.includes('fingerprint')
    || text.includes('指纹')
    || text.includes('身份')
    || text.includes('baseline')
    || text.includes('drift')
  ) {
    return {
      title: '身份环境检查未通过',
      detail: message,
      action: '请打开启动诊断，查看指纹、身份基线和配置一致性的具体问题。'
    }
  }

  if (text.includes('遗留进程') || text.includes('进程占用') || text.includes('orphan')) {
    return {
      title: '环境仍被浏览器进程占用',
      detail: message,
      action: '请先结束该环境的遗留进程，再重新启动。'
    }
  }

  return {
    title: '操作失败',
    detail: message,
    action: '请按详细原因处理；如果问题持续存在，可导出诊断包查看完整日志。'
  }
}

export function userFacingErrorText(error: unknown): string {
  const explained = explainRuntimeError(error)
  return [explained.title, explained.action, `详细原因：${explained.detail}`].filter(Boolean).join('；')
}
