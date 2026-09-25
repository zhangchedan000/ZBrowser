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

### Signed Beta 发布链

- Windows 与 macOS 正式签名构建改为独立手动工作流，不再由普通 dev Full E2E 直接发布候选。
- Windows signed release 会验证 Authenticode、时间戳、嵌入的 signed update config 和 Packaged App E2E。
- macOS signed release 会验证 Developer ID、Gatekeeper、notarization staple 和 signed update config。
- 普通 Full E2E 只负责构建、测试和 Beta acceptance kit，不占用正式 Beta tag。
- `0.2.0-beta.5` 预留给新的双平台 signed candidate，避免覆盖已发布的 `0.2.0-beta.4`。

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

- 当前仍属于 Beta，建议先在非关键 Profile 上验证再扩大使用范围。
- 正式 staged rollout 需要额外的平台 evidence、soak、更新成功率和 recovery drill。
- Windows / macOS 正式 signed candidate、平台 acceptance、soak evidence 与 recovery drill 仍需在对应签名发布环境完成。
