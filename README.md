# ZBrowser

ZBrowser 是一个本地优先、开源的多环境指纹浏览器项目，当前以 MIT 许可的 Prism Browser Community 为底座继续独立开发。

## 当前目标

第一阶段专注于三个核心能力：

- 独立浏览器环境：Cookie、缓存、LocalStorage、扩展和浏览数据彼此隔离。
- 指纹与网络配置：Windows/macOS、语言、时区、屏幕、CPU、GPU、Canvas/WebGL/Audio 等参数，以及 HTTP/HTTPS/SOCKS5 代理和 WebRTC 防泄漏。
- 环境检测：先做本地一致性检查，再使用当前 Profile 打开 BrowserLeaks、Pixelscan、IPhey、CreepJS 等第三方检测页复核实际环境。

## 当前开发状态

`dev` 分支已经加入：

- ZBrowser Windows 应用身份和自动构建。
- 每个 Profile 的“环境检测”入口。
- 本地配置一致性检查：代理、时区、语言/地区、WebRTC、硬件模板、浏览器版本、屏幕和 Seed。
- 新环境只推荐并允许选择与宿主系统一致的硬件 Persona；旧的跨系统环境保持原指纹但标记高风险，不会静默重写。
- 实际指纹诊断会用正常窗口模式读取 WebGL/WebGPU vendor、renderer/architecture 和 Windows/macOS 字体锚点，与当前 Persona 做运行时一致性核验；SwiftShader、Microsoft Basic Render Driver、WARP、llvmpipe 等软件渲染在真实窗口模式下按阻止级冲突处理。
- CI 的 headless GPU 结果允许作为非代表性告警，但 Full E2E 必须实际读到 WebGL vendor/renderer 并生成比对项，防止检测链路失效。
- 侧边栏提供“一键导出诊断包”，打包应用/runtime 信息、脱敏日志、启动诊断、崩溃历史和环境检测历史；默认不包含 Cookie、Local API Token、代理账号密码/主机、环境备注和启动网址。
- 临时检测网址启动机制：检测页使用当前 Profile 打开，但不会改写该环境原本保存的启动网址。
- 检测网址参数校验，仅允许 HTTP/HTTPS。


## 推荐使用流程

新建环境时建议按下面顺序操作：

1. 在“代理设置”中填写 HTTP / HTTPS / SOCKS5 代理并执行“检测连接”。
2. 检测成功后点击“应用推荐网络身份”，ZBrowser 会把网络身份设置为跟随代理，并同步语言、Accept-Language、时区、WebRTC 防泄漏和出口变化阻止策略。
3. 在“指纹设置”中选择完整硬件模板；已使用的环境不要随意修改 Seed。
4. 保存环境后点击“环境检测”，先查看本地一致性结果，再用同一 Profile 打开 BrowserLeaks、Pixelscan、IPhey、CreepJS。
5. 后续复测会保留本地检测历史，可查看 IP、时区、语言、内核、硬件模板和 Seed 是否发生漂移。

## Local API（V1）

ZBrowser 启动后会同时启动仅绑定本机回环地址的 Local API：

- 默认地址：`http://127.0.0.1:17653`，不会监听局域网或公网地址。
- 首次启动会生成随机 Bearer Token，保存在 `<userData>/vault/local-api.token`；Token 不写入日志、不放在 URL 中。
- 当前监听地址、实际端口和 Token 文件位置写入 `<userData>/vault/local-api.json`，自动化程序可从这里发现 API。
- 可通过 `ZBROWSER_LOCAL_API_PORT` 修改端口；测试或托管场景可设为 `0` 使用系统分配端口。
- 可通过 `ZBROWSER_LOCAL_API_TOKEN` 提供已有 Token；至少 32 个非空白字符。
- Profile 列表只返回必要的运行摘要，不返回代理主机、用户名、密码、Cookie 或其他凭据。
- 桌面端左侧“自动化 API”可查看当前本机地址、Token 文件位置和已开放能力；页面不会读取或显示 Token 明文。

V1 路由：

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
```

同时保留 `/api/profile/list`、`/api/profile/start`、`/api/profile/stop`、`/api/profile/status` 和 `/api/cdp/connect` 兼容入口。所有请求都必须发送：

```text
Authorization: Bearer <local-api.token 中的 Token>
```

Windows 环境启动后，Local API 可返回仅绑定 `127.0.0.1` 的临时 CDP 地址，可直接交给 Playwright / Puppeteer 的 CDP 连接能力。CDP 不绑定 `0.0.0.0`，也不会通过 Local API 返回代理或账号凭据。

页面控制接口复用 ZBrowser 自己的 `BrowserControlSession`：`page/open` 只接受 HTTP/HTTPS，`page/snapshot` 返回有大小上限的可访问性树和短期元素引用（例如 `p1-e3`），`page/type` 与 `page/click` 使用这些引用操作当前 Profile。页面导航、输入或点击后引用会失效，自动化程序应重新调用 `page/snapshot` 获取新引用。

## Windows 构建

GitHub Actions 会在 `dev` 分支提交后自动执行：

```text
npm ci
npm run typecheck
npm run dist:win
```

并上传 MSI、Portable 和 ZIP 构建产物。

> 当前 CI 构建的是应用本体，不把大体积 Chromium 二进制提交进源码仓库。首次运行后可从“浏览器内核”页面直接查看并下载安装公开的 Fingerprint Chromium 发行版。ZBrowser 会校验 GitHub Release 提供的 SHA-256，再安装到本机 Vault。

## 开发原则

- 不破解或绕过 Prism Pro 授权。
- Community 开源底座继续遵守原 MIT License。
- 自研 Local API、MCP、计划任务等能力时采用独立实现。
- 指纹内核下载源当前为 BSD-3-Clause 的 `adryfish/fingerprint-chromium`；Chromium 144.0.7559.132 为当前推荐兼容版本，新版内核先标记为实验并要求重新做环境检测。
- 不把代理密码、Cookie、Token、API Key 或账号凭据提交到仓库。

## Upstream

初始代码来源：

- [DFarm6/Prism-Browser-Community](https://github.com/DFarm6/Prism-Browser-Community)

原始 MIT License 和第三方开源许可声明继续保留。Chromium 及其组件的分发需保留相应 LICENSE、LICENSES 和组件 notices。


## 指纹内核

ZBrowser 的“浏览器内核”页面支持：

- 在线读取 `adryfish/fingerprint-chromium` 的 GitHub Releases。
- Windows x64 下载、断点续传、SHA-256 校验、安装和完整性检查。
- 内核切换、回滚、本地构建导入和移除。
- Profile 固定的是 Chromium 主版本 + 内核系列；同一主版本内会自动选择不低于当前下限的最高已安装补丁。
- 自动补丁升级不会降级，也不会跨主版本；跨主版本必须由用户明确升级。
- 同主版本新补丁只有在浏览器实际成功启动后才会推进该 Profile 的版本下限。
- 批量升级默认逐个执行，可先升级 1 个环境做运行时诊断；失败立即暂停并可从升级前备份回滚。
- 升级后的运行时诊断会核对 `navigator.userAgent` 与 UA-CH `fullVersionList` 是否与实际内核版本一致。
- 内核升级备份只保留最近 1 份，并排除可重新生成的 Chromium Cache；正常使用进入 7 天保留期后自动清理。

ZBrowser 不使用或绕过 Prism Pro 内核授权。开源内核的第三方许可说明见 `THIRD_PARTY_NOTICES.md`。
