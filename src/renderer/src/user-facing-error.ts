export interface UserFacingError {
  title: string
  detail: string
  action?: string
}

export function explainRuntimeError(error: unknown): UserFacingError {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
  const text = message.toLowerCase()

  if (text.includes('kernel') || text.includes('chromium') || text.includes('executable')) {
    return {
      title: '浏览器内核无法使用',
      detail: message,
      action: '请打开内核管理，安装或切换对应内核后重试。'
    }
  }

  if (text.includes('proxy') || text.includes('代理') || text.includes('timeout')) {
    return {
      title: '代理连接异常',
      detail: message,
      action: '请检查代理地址、端口、账号密码以及节点状态。'
    }
  }

  if (text.includes('permission') || text.includes('owner') || text.includes('权限')) {
    return {
      title: '当前账号没有操作权限',
      detail: message,
      action: '请联系主账号重新分配环境或权限。'
    }
  }

  if (text.includes('identity') || text.includes('fingerprint') || text.includes('runtime')) {
    return {
      title: '身份环境检查未通过',
      detail: message,
      action: '请打开诊断中心查看具体配置问题。'
    }
  }

  return {
    title: '操作失败',
    detail: message,
    action: '如果问题持续存在，请导出诊断包查看详细日志。'
  }
}
