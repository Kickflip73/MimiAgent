# Blocked

- **M1.1 只剩 24h 日历 soak**：正式实机已累计 103/103 成功，四类能力均有分层样本，
  S0/S1=0；不再受旧 active Event 校准阻塞。只读窗口从
  `2026-07-28T07:46:52.864Z` 起算，最早在 `2026-07-29T07:46:52.864Z` 后验收。
  heartbeat `m1-24h` 已启用；日历时间不可用并行测试伪造或压缩。
- **凭证轮换需 owner/外部系统（M-1）**：2026-07-28 发现一枚 Multica access token 曾进入 Task objective、Schedule 和 Memory observation；原值不在本文件或诊断输出中。已扩展统一净化器，验证备份后净化 50 个数据库值，复扫 0 命中，原始记录仅保留在权限受限的已验证恢复备份。该凭证必须在 Multica 控制面吊销并重发；MimiAgent 不得代替 owner 点击授权或猜测新值。
- **M1 大象真实目标绑定需 owner/外部状态**：当前没有 owner 选定的精确会话、授权 revision，也没有唯一且非活动的已登录大象网页会话可用于 stable sid 绑定。允许完成 deterministic fixture、bounded read、Draft 和 fail-closed 代码；不得写入猜测目标、不得启用真实发送、不得伪造 72h soak。
- **macOS Life 恢复需 Calendar/Reminders TCC**：`macos-life` 属于 M4，当前保持 disabled 且配置完整。只有 owner 授权后，按 `docs/CONNECTORS.md` 的只读 probe 和恢复门禁重新启用；不得代点系统授权。
- **个人 QQ 恢复需真实 Adapter**：`personal-qq` 属于 M1，当前仅有未实现配置槽位，保持 disabled 且配置完整。实现并通过账号、稳定会话、bounded coverage、后台安全和 uncertain 测试前不得启用。
