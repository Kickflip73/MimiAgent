# Blocked

- **Ledger 事故已修复并实机核验（2026-07-28）**：事故备份保持原 SHA-256 且不删除；真实磁盘已从 v1 原子迁移到 v2，备份 95 entries 在当前 96 entries 中 missing=0、changed=0。未来版本会明确拒绝旧二进制回退，原文件不隔离、不写 blocking marker。
- Doctor `ready=false` 仅剩真实历史/外部阻塞：84 条历史 dead letter 保留且 unclassified=0（provider 38、worker_runtime 23、cancelled/superseded 12、configuration 10、dependency 1）；personal-qq offline，macos-life 缺 Calendar 权限，personal-daxiang 缺唯一且非活动的已登录标签。不得通过删除历史或伪造 ready 消除。
- Connector readiness unknown 已清零；Computer Use 已默认启用且 `ready=true`。真实外部能力仍未就绪：personal-qq offline、macos-life 缺 Calendar 权限；personal-daxiang 已自动诊断并尝试安全恢复，但当前没有唯一、非活动的已登录大象标签可绑定，故保持 unavailable。
- Owner 于 2026-07-28 明确停止 30 分钟 soak；实际约 6 分钟窗口内 dead letter 84→84、Outbox open 0→0、Digest 77→77、Daemon PID/build 稳定。完整 30 分钟及 30/90 天 soak、外部账号实机次数和真实日历跨度留给后续目标。
