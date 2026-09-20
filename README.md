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
- 临时检测网址启动机制：检测页使用当前 Profile 打开，但不会改写该环境原本保存的启动网址。
- 检测网址参数校验，仅允许 HTTP/HTTPS。

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
- Chromium `144.0.7559.132` 标记为当前“推荐兼容”。
- 高于 144 的开源版本标记为“新版实验”，安装前会提示先在测试环境验证 Canvas、WebGL、GPU、Audio、WebRTC、语言与时区一致性。

ZBrowser 不使用或绕过 Prism Pro 内核授权。开源内核的第三方许可说明见 `THIRD_PARTY_NOTICES.md`。
