# ZBrowser Beta 验收包

这套目录用于把 ZBrowser Beta 候选版本的发布条件、证据格式和验证脚本放在一起。它不是自动“批准发布”的工具；最终推广仍需要人工查看证据并决定是否进入下一阶段。

## 1. 导出与完整性检查

在仓库根目录执行：

```bash
npm run beta:export-kit -- release/beta-acceptance-kit
npm run beta:verify-kit -- release/beta-acceptance-kit
```

导出结果会包含：

- 本说明
- Beta rollout policy
- 当前 Beta release contract
- 更新配置示例
- evidence 模板
- 更新候选验证脚本
- evidence 验证脚本
- 文件完整性清单 `verification.json`

`beta:verify-kit` 会核对文件清单、大小和 SHA-256。Full E2E 也会运行这两步，所以缺文件或导出包损坏会阻止 Beta 发布链继续。

## 2. 候选版本约束

当前候选版本由 `build/beta-release.json` 定义，并必须与 `package.json` 保持一致。

Beta 正式 rollout evidence 要求使用**签名的更新清单**。内部本地测试可以使用 `internal-unsigned` 配置，但它不能替代正式 Beta rollout gate。

候选验证：

```bash
npm run beta:verify-candidate -- \
  --manifest <signed-beta-manifest.json> \
  --public-key <ed25519-public-key.pem> \
  --artifact darwin-arm64,<candidate.dmg> \
  --artifact win32-x64,<candidate.exe> \
  --acceptance darwin-arm64,<mac-acceptance.json> \
  --acceptance win32-x64,<windows-acceptance.json> \
  --require-channel beta \
  --output <candidate-report.json>
```

候选报告必须满足：

- Ed25519 签名有效
- channel 为 `beta`
- 版本格式为 `x.y.z-beta.n`
- Windows / macOS 本地候选文件与签名清单的大小和 SHA-256 一致
- 平台 acceptance 文件与候选版本一致
- Windows 签名/时间戳通过
- macOS Developer ID / Gatekeeper / notarization staple 通过

## 3. Beta evidence

先复制模板：

```text
evidence.template.json -> evidence.json
```

为 Windows 和 macOS 各准备一个 evidence bundle，并把 bundle 的 SHA-256 写入 evidence 文件。

验证：

```bash
npm run beta:validate-evidence -- \
  --candidate <candidate-report.json> \
  --evidence <evidence.json> \
  --policy <beta-rollout-policy.json> \
  --evidence-bundle darwin-arm64,<mac-evidence.zip> \
  --evidence-bundle win32-x64,<windows-evidence.zip> \
  --output <beta-gate-report.json>
```

验证内容包括：

- Full App E2E
- 原生指纹与固定模板验证
- Profile 数据隔离/保留
- 代理与网络身份验证
- 每个平台的 soak 时长
- 启动次数与 crash-free rate
- 更新尝试与更新成功率
- newer recovery build 恢复演练
- 分阶段 rollout 的观察时长和 pause signals

## 4. AI / MCP 与巡检验收

当前 Beta 还应人工确认以下产品行为：

- Local API 只绑定 `127.0.0.1`，Bearer Token 不在 UI 或日志中显示。
- MCP 客户端通过桌面“自动化 API · MCP”页拿到启动配置并能通过 Self-Check。
- `attention_queue` / `attention_plan` / `attention_insights` 为只读聚合。
- `attention_audit` 只自动执行现有安全巡检和 Policy 允许的低风险动作。
- 高风险 Self-Healing 必须进入待确认，不能由 MCP 或周期巡检自动越权执行。
- 桌面确认执行时 Main 会重新校验最新待确认状态，过期确认会被拒绝。
- 周期巡检默认关闭；启用后应用重启可恢复调度。
- 手动巡检与周期巡检同时触发时应 single-flight，只执行一轮真实巡检。
- 巡检历史最多保留最近 50 次紧凑记录，不持久化完整 Runtime 指纹 payload。

## 5. Rollout 原则

`beta-rollout-policy.json` 定义阶段和最低证据门槛。工具不会自动扩大 rollout。

任何 pause signal 出现时：

1. 停止继续扩大 rollout。
2. 保存当前 candidate、evidence 和诊断包。
3. 修复问题并发布**更高版本号**的 recovery build。
4. 重做更新/回滚和 Profile 数据保留验证。
5. 用新的 evidence 重新通过 gate。

不要覆盖已发布的 Beta tag 或 release；ZBrowser 的 prerelease 产物按版本保持不可变。
