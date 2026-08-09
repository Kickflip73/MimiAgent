# M3 Blocked / Evidence Boundaries

## 仍然有效的外部门禁

- 长期运行 Daemon 尚未完成部署与 ARC-503 验收。它不阻塞隔离 M3 工程和 fixture，但阻塞
  “已进入产品运行阶段”、主线部署和 promotion `GO` 的结论。
- 最新不可变 M1 退出记录
  `../../../evals/m1/exit-records/20260803T180700+0800-no-go.json` 的 decision 是
  `NO-GO`；CUA exact-window grounding、最终 30-sample live matrix、所需写覆盖、Provider
  credential rotation 与 restore window 仍在该记录的 unresolved 中。M3 不编辑或覆盖它。
- 实时语音的真实 ASR/TTS/turn detection/barge-in、设备释放和延迟指标只有在支持的模型、
  realtime transport、麦克风和播放器均 readiness 通过时才 eligible。缺任一条件时必须
  fail closed 或降级为文本，不能用分段 Voice Connector fixture 代替真实双工证据。
- 宿主无人值守时，Shell/process、Computer act、真实 Connector 写和受监督 live 场景为
  ineligible；它们不阻塞其余 Safe、临时 workspace 和 loopback fixture 场景继续执行。

## 已解决但不得回退的门禁

- M2 owner Catalog 活动 WAL 不再是未完成项。owner 显式 `--allow-wal` 后，100 问只读审计
  为 64 partial / 36 evidence-insufficient / 0 incorrect、来源覆盖 100%、
  `auditStatus=complete`，且主 DB SHA/大小保持不变。M2 工程验收可关闭。
- owner 对 M3 的裁决是“允许隔离并行工程”，不是删除长期 Daemon/ARC-503 或 M1
  `NO-GO`。蓝图、Progress 和报告必须同时保留这两层事实。
- 基线唯一 Tool schema 超预算已定位并做最小模型视图压缩；模型视图预算由 4046 降至
  3734，且已随 1023/1023 完整测试、coverage CI、构建和 package smoke 一起通过。

## 证据计数边界

- 当前没有已证明的 M3 live 会话、实时语音轮次或 100×30 终端轮次。S-lane no-tools
  calibration 的工程派发门禁已经完成，但在持久 PTY、1-turn、2x5 的原始证据落盘前仍按
  `realProviderTurnsExecuted=0` 记录。
- `bench:capacity`、直接调用内部函数、静态 fixture、合成 transcript、readiness probe 和
  单次 Browser/Computer E2E 都不能计入 3000 个真实 user turns。
- 自动化 headless CLI lane 必须走 CLI -> Daemon -> 真实 Provider 并保留 Run/Trace/Session/
  usage 证据；它仍不能被称为 `tty:true` 持久 PTY。正式 soak 前另做持久 PTY 多轮 smoke。
- fixture、readiness、live_action 和 soak 分层独立；blocked、ineligible、skipped、failed、
  uncertain 和 unproven 均不得从分母静默删除。
- 外部能力阻断只隔离相应 scene/lane。除非所有安全替代路径都耗尽，否则继续执行其余场景。

## 当前 checkpoint 的工程边界

- 同轮 image/file attachment 已可达，并已有 CAS/`MediaEvidence`/opaque workspace/ref 生命周期
  安全路径；这不覆盖 `generate_image` / edit-image 的 ledger 前 CAS 化，也不证明同 Session
  第二轮或重启后能按 `mediaEvidenceId` 重注入原图。生成图片闭环仍是阻断项。
- `@audio/@video` 目前只允许有界摄取后明确 blocked。没有生产 transcript、音轨、关键帧、
  time-range 或 MemoryCandidate caller；schema fixture 不得计为分析成功。尚无可信有界 probe 的
  container/codec 继续 fail closed，结构完整性 hardening 保留在 backlog。
- Realtime transport/controller 是 transcription-only contract：没有 CLI/Daemon/Session actor
  composition root，也没有产品 mic source、speaker sink 或实机 stop/latency evidence。它不能被
  宣称为实时语音、双工、barge-in 或文本降级已经可用。
- conversation manifest 的 103 个场景与 3090 轮都是 declared，不是 executed。专用 no-tools
  RunPolicy、模型派发前空 Tool surface receipt 及 Event→Task→Run→Session/Trace/终端文件
  绑定已允许隔离 S-lane calibration；W/F fixture、逐场景 action/oracle、完整 resume 与正式
  100×30 soak 仍保持 Provider 前 `NO-GO`。`realProviderTurnsExecuted=0`、正式分母为 0，直到
  真实校准证据通过审计后才可更新前者；校准轮次也不计入正式分母。
- CAS owner/ref/GC 已进入 production attachment path，并通过完整单测/coverage CI 以及进程
  终止、锁恢复、并发 owner、启动 reconcile 等确定性 fault-injection；真实掉电与长期配额/GC
  soak 仍未形成 promotion 证据。发生不确定恢复状态时必须保留 ref 并失败关闭，不能用 unit
  test 替代外部 soak。
- 现有 daemon backup/restore 尚未把 `attachments/` CAS/owner refs 和
  `session-workspaces.json` 放进同一恢复一致性协议。删除源数据后的 restore 可能保留
  Event/Session 中的 opaque ref，却丢失 blob 或 workspace 映射；因此 M3 product `GO`
  必须先升级 backup schema，并通过 backup -> 删除源 -> restore -> read/dispatch E2E。
