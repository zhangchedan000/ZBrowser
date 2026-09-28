# ZBrowser 0.2.0-beta.7

## 重点修复

- 代理环境启动后，Chromium 自己会通过真实页面导航验证外网连通性；Node 代理检测通过但 Chromium 实际没网时，不再进入“运行中”。
- Chromium 真实导航出现 ERR_PROXY_CONNECTION_FAILED、超时或外部页面不可达时，环境会直接标记启动失败并停止浏览器。
- Chromium 联网探测使用后台临时页面，探测结束立即关闭，不污染用户环境标签页。

## 验证

- Typecheck 通过。
- BrowserLauncher / BrowserControlSession 相关回归测试 22/22 通过。
- 完整测试 353 passed / 1 skipped，Kernel Lock 通过。

---

# ZBrowser 0.2.0-beta.6

## 重点修复

- 修复代理“检测通过但实际网页打不开”的误判：代理检测现在必须通过普通 HTTP / HTTPS 网页可达性检查，不再只依赖 GeoIP / 出口 IP 接口。
- 浏览器运行期间第一次真实代理上游失败就会在环境列表显示“运行中 · 异常”，恢复真实流量后自动清除；仍保持 fail-closed，不会偷偷直连。
- 指纹硬件 Persona 可转为“手动自定义”，保留当前值后可修改系统、CPU、分辨率等字段。
- 修复删除内核后重新安装时状态不同步 / 无明显反馈的问题；有环境运行时会明确提示需先关闭环境。
- 修复应用关闭阶段 Attention Patrol 回调触发 Object has been destroyed 的主进程异常。
- 修复 Windows CI 对 .patch 文件 CRLF 转换导致 Kernel Lock SHA 校验失败的问题。

## 验证

- Typecheck、Unit / Integration Tests、Kernel Lock、Windows Build、Windows Full E2E、Packaged App E2E 均作为发布门槛。
- 该版本仍为 internal-unsigned Beta，用于个人自用验证。

---

# ZBrowser 0.2.0-beta.5

## 重点变化

### AI 多环境巡检

- 新增统一 Attention Queue，合并进程异常、Identity Health 和 Self-Healing。
- 新增 Attention Plan，按当前严重度和历史反复异常排序。
- 新增安全巡检执行器，串行处理多个环境并隔离单环境失败。
- 新增巡检后自动复查，区分已解决、仍存在和新出现问题。
- 新增最近 50 次巡检历史和长期异常 Insights。
- 支持识别反复失败、反复需要人工确认和 Identity Health 持续下降。

### 高风险确认闭环

- 高风险 Self-Healing 不会被 AI 或周期任务自动越权执行。
- 桌面巡检面板可查看具体策略和原因。
- 用户确认后 Main Process 会重新校验最新待确认状态。
- 执行后进行 Runtime 验证并自动复查。
- Manual Review 只显示人工处理说明，不伪装成自动修复。

### 周期自动巡检

- 默认关闭。
- 支持 15 / 30 / 60 / 180 分钟周期。
- 应用重启后恢复已启用的调度。
- 单次失败不会停止后续巡检。
- 手动巡检和周期巡检使用 single-flight，避免重复执行。

### Identity Health / Self-Healing / MCP

- Local API 和 MCP 可读取 Identity Health 汇总与历史。
- Local API 和 MCP 可读取 Self-Healing 历史。
- MCP 新增 Attention Queue / Plan / Audit / History / Insights。
- Windows packaged app 使用独立 Node-mode MCP stdio launcher。
- 桌面 MCP 页面提供真实 Self-Check 和可复制客户端配置。

### 稳定性

- 40 路并发巡检请求只执行一轮真实巡检。
- 75 路并发巡检历史写入保持原子性，并严格保留最新 50 条。
- 周期巡检失败恢复和重启恢复已有自动化测试。
- Windows Development Runtime 和 Packaged App Full E2E 均为发布门槛。

### 个人自用发布链

- `0.2.0-beta.5` 当前按 `internal-unsigned` 模式验收，不购买或要求 Windows / Apple 代码签名证书。
- Windows Build 直接生成 MSI、Portable EXE 和 ZIP；Windows Full E2E 继续验证 Development Runtime、Packaged App 和 Beta Acceptance Kit。
- macOS Build Smoke 生成 unsigned arm64 ZIP，并校验 Bundle ID、版本号和 SHA-256。
- signed release / notarization / signed candidate gate 保留为以后公开分发时的可选流程，不再阻塞当前个人自用版本。
- 普通 CI 不创建公开 GitHub prerelease，避免把内部自用构建误当正式公开发布。

## Beta 安全边界

- Local API / CDP 仅监听回环地址。
- Token 不在桌面页面或普通日志中显示。
- 巡检历史不保存完整 Runtime 指纹 payload。
- 高风险 Self-Healing 必须由用户明确确认。
- MCP 不提供绕过用户确认的高风险执行入口。

## 安装包

Windows CI 生成：

- MSI
- Portable EXE
- ZIP

发布前会经过 Typecheck、Unit / Integration Tests、真实代理 Smoke、Kernel Lock、Development Runtime Full E2E、Packaged App Full E2E、发布物检查和 Beta Acceptance Kit 完整性检查。

## 已知 Beta 事项

- 当前仍属于 Beta，个人自用时建议先在非关键 Profile 上验证。
- Windows 未签名安装包可能显示“未知发布者”或 SmartScreen 提示；macOS unsigned ZIP 首次启动可能需要用户手动允许。
- 如果以后改为公开分发，再补 Windows Authenticode、Apple Developer ID / notarization、平台 evidence、recovery drill 和 staged rollout。

