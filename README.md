# ZBrowser

ZBrowser 是一个本地优先、开源的多环境指纹浏览器，基于 Prism Browser Community 的 MIT 开源代码继续独立开发。项目当前处于 **0.2.0 Beta** 阶段，重点已经从“核心能力搭建”进入稳定性、自动化和 Beta 验收收口。

## 当前能力

### 多环境与数据隔离

- 每个 Profile 独立 Cookie、缓存、LocalStorage、扩展和浏览数据。
- 分组、标签、收藏、回收站、缓存管理和 CSV 批量创建。
- Cookie / 配置导入导出、备份恢复、加密 Workspace 迁移。
- 崩溃历史、孤儿进程恢复、应用非正常退出诊断。

### 指纹与网络身份

- Windows / macOS 指纹平台、语言、时区、屏幕、CPU、GPU、Canvas / WebGL / Audio 等配置。
- 完整硬件 Persona，限制新环境选择与宿主系统不一致的高风险模板。
- HTTP / HTTPS / SOCKS5 代理、代理池、连通性与出口身份检测。
- 网络身份可跟随代理，同步时区、语言、 Accept-Language 和 WebRTC 防泄漏策略。
- 环境检测可使用当前 Profile 打开 BrowserLeaks、Pixelscan、IPhey、CreepJS。

### Fingerprint Chromium 内核

- 在线读取公开 Fingerprint Chromium release。
- Windows x64 下载、断点续传、SHA-256 校验、安装、完整性检查。
- 内核切换、回滚、本地构建导入和移除。
- Profile 固定 Chromium 主版本 + 内核系列；同主版本补丁可安全前进，不自动跨主版本。
- 升级前备份、运行时验证、失败回滚和批量逐个升级。
- Runtime 会核对 UA、UA-CH、WebGL、WebGPU、GPU、字体、CPU、屏幕、语言和时区。

### Identity Health 与 Self-Healing

ZBrowser 会持续记录 Profile 的身份健康状态：

- Identity Baseline
- Identity Drift
- Identity Health Score / Risk
- Health Trend
- Runtime Fingerprint Diagnostic
- Repair Strategy
- Self-Healing Manual / Assisted / Auto

Self-Healing 带有冷却、尝试次数、循环失败和并发保护。高风险策略不会因为 AI 或周期任务而自动越权执行。

### AI 多环境巡检

桌面“自动化 API · MCP”面板提供统一巡检能力：

1. 发现进程、Identity Health 和 Self-Healing 问题。
2. 合并成统一 Attention Queue。
3. 根据当前严重度 + 历史反复失败/持续下降信号排序。
4. 生成处理计划。
5. 运行安全巡检。
6. Policy 允许的低风险动作可按现有 Self-Healing 规则执行。
7. 高风险动作必须由用户明确确认。
8. 执行后自动复查，区分：
   - 已解决
   - 仍存在
   - 新出现
9. 保存最近 50 次紧凑巡检历史。
10. 识别反复失败、经常需要人工确认和 Identity 持续下降的环境。

周期巡检默认关闭。用户可以在桌面面板启用：

- 每 15 分钟
- 每 30 分钟
- 每 1 小时
- 每 3 小时

手动巡检和周期巡检使用 single-flight，同一时刻只会真正执行一轮。应用重启后会恢复已开启的周期配置。

## 推荐使用流程

1. 新建 Profile，并选择与宿主系统一致的硬件 Persona。
2. 配置代理并执行“检测连接”。
3. 使用“应用推荐网络身份”同步网络相关身份配置。
4. 安装并选择推荐 Fingerprint Chromium 内核。
5. 保存后运行“环境检测”和 Runtime Fingerprint Diagnostic。
6. 建立 Identity Baseline。
7. 日常使用中通过“需要处理”或“自动化 API · MCP”查看 Identity Health / Self-Healing。
8. 可手动运行“安全巡检”，或按需开启周期自动巡检。
9. 对高风险待确认项查看具体策略和原因，再由用户决定是否执行。

## Local API V1

ZBrowser 启动后会同时启动仅绑定本机回环地址的 Local API：

- 默认地址：`http://127.0.0.1:17653`
- 不监听局域网或公网地址。
- 首次启动生成随机 Bearer Token：
  `<userData>/vault/local-api.token`
- API 元数据：
  `<userData>/vault/local-api.json`
- Token 不显示在桌面页面，不写入普通日志，不放在 URL 中。
- 可用 `ZBROWSER_LOCAL_API_PORT` 修改端口；设为 `0` 时使用系统分配端口。
- 可用 `ZBROWSER_LOCAL_API_TOKEN` 提供至少 32 个非空白字符的 Token。

主要能力：

```text
GET  /api/v1/health
GET  /api/v1/profiles
GET  /api/v1/profiles/:id/status
POST /api/v1/profiles/:id/start
POST /api/v1/profiles/:id/stop
GET  /api/v1/profiles/:id/cdp

POST /api/v1/profiles/:id/page/open
GET  /api/v1/profiles/:id/page/snapshot
POST /api/v1/profiles/:id/page/type
POST /api/v1/profiles/:id/page/click

POST /api/v1/profiles/:id/proxy/test

POST /api/v1/profiles/:id/diagnostics/launch
POST /api/v1/profiles/:id/diagnostics/kernel-runtime
POST /api/v1/profiles/:id/diagnostics/fingerprint-runtime

GET  /api/v1/identity-health
GET  /api/v1/profiles/:id/identity-health
GET  /api/v1/profiles/:id/identity-health/history

GET  /api/v1/self-healing
GET  /api/v1/profiles/:id/self-healing
POST /api/v1/profiles/:id/self-healing/check
GET  /api/v1/profiles/:id/self-healing/history

GET  /api/v1/attention
GET  /api/v1/attention/plan
POST /api/v1/attention/audit
GET  /api/v1/attention/audit/history
GET  /api/v1/attention/insights
```

所有请求必须发送：

```text
Authorization: Bearer <local-api.token 中的 Token>
```

Profile 列表与状态接口不会返回代理密码、Cookie、Token 等凭据。

## MCP

ZBrowser 内置 stdio MCP Server。桌面“自动化 API · MCP”页面会显示可直接复制到 MCP 客户端的启动配置，并提供真实 Self-Check。

当前 MCP 工具：

```text
profiles_list
profile_status
profile_start
profile_stop

attention_queue
attention_plan
attention_audit
attention_audit_history
attention_insights

identity_health_list
profile_identity_health
profile_identity_health_history

self_healing_list
profile_self_healing_status
profile_self_healing_check
profile_self_healing_history

profile_proxy_test
profile_diagnose_launch
profile_diagnose_kernel_runtime
profile_diagnose_fingerprint_runtime

page_open
page_snapshot
page_type
page_click
```

安全边界：

- Attention / Identity Health / Self-Healing 历史接口为只读。
- `attention_audit` 可执行安全巡检，以及现有 Policy 已允许的低风险 Self-Healing。
- 高风险待确认项不会由 MCP 自动执行。
- 桌面确认执行前 Main Process 会重新校验最新状态，过期确认会被拒绝。
- `manual_review` 不会伪装成可自动执行的修复。

## Windows 构建与验证

`dev` 提交会运行 Windows Build 和 Windows Full E2E。

完整链包括：

```text
npm ci
Typecheck
Unit / Integration Tests
Proxy Smoke
Kernel Lock
Build Application
Kernel Manager UI Smoke
Development-runtime Full App E2E
Windows MSI / Portable / ZIP
Packaged-app Full E2E
Release Deliverable Verification
Beta Acceptance Kit Export + Integrity Verification
```

普通 `dev` Full E2E 不再创建 GitHub prerelease，避免未签名产物占用正式 Beta tag。正式候选由 Windows / macOS signed release 流程生成，并在完成签名候选验收后使用新的 Beta 版本号发布。

当前 Windows 发布物：

- MSI
- Portable EXE
- ZIP

源码仓库不提交大体积 Chromium 二进制。应用可从“浏览器内核”页面下载安装公开 Fingerprint Chromium，并校验 release SHA-256。

## Beta 验收

当前 Beta candidate contract 位于：

```text
build/beta-release.json
build/beta-rollout-policy.json
```

导出验收包：

```bash
npm run beta:export-kit -- release/beta-acceptance-kit
npm run beta:verify-kit -- release/beta-acceptance-kit
```

更完整的候选签名、平台 evidence、recovery drill 和 staged rollout 流程见：

```text
tools/beta-acceptance/README.md
```

Windows 正式 Authenticode 候选可通过手动 `Windows Signed Release` 工作流执行；macOS 正式 Developer ID / notarization 候选可通过手动 `macOS Signed Release` 工作流执行。两个流程都会输出供 Beta signed candidate gate 使用的平台 acceptance 报告。

Beta release/tag 是不可变的。已有版本不会被后续 `dev` 构建覆盖；需要发布新候选时必须提升版本号。

## 安全与隐私原则

- 不破解或绕过 Prism Pro 授权。
- 不把代理密码、Cookie、Token、API Key 或账号凭据提交到仓库。
- Local API / CDP 仅绑定回环地址。
- Diagnostics Bundle 默认脱敏，不包含 Cookie、Local API Token、代理凭据等敏感字段。
- AI 自动化不绕过现有 Self-Healing Policy 和用户确认边界。

## 开源与第三方

初始代码来源：

- DFarm6/Prism-Browser-Community

ZBrowser 继续保留原 MIT License 和第三方许可声明。

Fingerprint Chromium 下载源当前使用：

- adryfish/fingerprint-chromium

相关第三方许可见 `THIRD_PARTY_NOTICES.md`。
