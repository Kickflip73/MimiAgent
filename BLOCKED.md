# Blocked

- **M1.1 等待运行时重新冻结并重启 24h 日历 soak**：历史正式实机已累计 129/129
  成功；构建 `0.12.0+9bf15be88f93` 的首轮正式 canary 完成 20/20，
  Browser/Computer/Screen/Shortcuts 各 5/5，blocked/failed/uncertain=0，
  S0/S1/S2/S3=0。原只读窗口从 run
  `ac47a076-956d-469d-b5b7-4a9036cf7947` 完成时间
  `2026-07-28T10:28:51.828Z` 起算，但 Daemon 已于
  `2026-07-28T12:07:07.169Z` 重启为未锁定构建 `0.12.0+316eb41416db`，连续窗口
  因此中断。观察时还有 1 个 active Event，本轮 heartbeat 只记录 blocked，没有
  执行 canary。`2026-07-28T16:24:10.725Z` 再次观察时，Daemon 又变为
  `0.12.0+376bb1fbacc9`，并有 1 个 active Task worker，仍不满足精确构建和 idle
  门禁。`2026-07-28T20:23:36.277Z` 时运行面已 idle，但构建仍是
  `0.12.0+376bb1fbacc9`，所以精确构建门禁继续失败。需先将当前运行时改动形成
  可追溯提交、通过发布验证并冻结部署，再从新 T0 重新计算不可压缩的 24h。
  `2026-07-29T00:24:05.735Z` 再次确认仍是同一非目标构建且运行面 idle，没有
  新 T0，本轮继续只记录 blocked。`2026-07-29T04:23:41.301Z` 时 Daemon 又重启
  为 `0.12.0+27e9a5182037`；虽然 idle，但工作区仍有未提交运行时改动，依然不能
  建立新 T0。`2026-07-29T08:24:41.809Z` 时 Daemon 再次变为
  `0.12.0+9ea51be56887`，并有 2 个 active Event 与大范围未提交改动，本轮两项
  门禁均失败，继续只记录 blocked。
- **凭证轮换需 owner/外部系统（M-1）**：2026-07-28 发现一枚 Multica access token 曾进入 Task objective、Schedule 和 Memory observation；原值不在本文件或诊断输出中。已扩展统一净化器，验证备份后净化 50 个数据库值，复扫 0 命中，原始记录仅保留在权限受限的已验证恢复备份。该凭证必须在 Multica 控制面吊销并重发；MimiAgent 不得代替 owner 点击授权或猜测新值。
- **M1 大象真实目标绑定需 owner/外部状态**：当前没有 owner 选定的精确会话、授权 revision，也没有唯一且非活动的已登录大象网页会话可用于 stable sid 绑定。允许完成 deterministic fixture、bounded read、Draft 和 fail-closed 代码；不得写入猜测目标、不得启用真实发送、不得伪造 72h soak。
- **macOS Life 恢复需 Calendar/Reminders TCC**：`macos-life` 属于 M4，当前保持 disabled 且配置完整。只有 owner 授权后，按 `docs/CONNECTORS.md` 的只读 probe 和恢复门禁重新启用；不得代点系统授权。
- **个人 QQ 恢复需真实 Adapter**：`personal-qq` 属于 M1，当前仅有未实现配置槽位，保持 disabled 且配置完整。实现并通过账号、稳定会话、bounded coverage、后台安全和 uncertain 测试前不得启用。
