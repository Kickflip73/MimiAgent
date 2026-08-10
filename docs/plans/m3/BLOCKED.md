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

- 当前没有已证明的 M3 live 媒体会话、实时语音轮次或 100×30 正式终端轮次。S-lane no-tools
  持久 PTY prerequisite、1×1 与 2×5 calibration 已有独立的真实 Provider 原始证据，但都标为
  calibration-only，不计正式分母。截至 `4bf889e` correction，累计
  `actualRealProviderTurnsExecuted=20`、`provenCalibrationTurns=13`，但
  `formalDenominatorTurns=0`。某次 manifest validation 中的 `realProviderTurnsExecuted=0` 只表示
  该 validation 命令没有派发模型，不能覆盖上述累计事实。
- `bench:capacity`、直接调用内部函数、静态 fixture、合成 transcript、readiness probe 和
  单次 Browser/Computer E2E 都不能计入 3000 个真实 user turns。
- 自动化 headless CLI lane 必须走 CLI -> Daemon -> 真实 Provider 并保留 Run/Trace/Session/
  usage 证据；它仍不能被称为 `tty:true` 持久 PTY。固定提交 `2cc22fb` 的真实持久 PTY 已关闭
  正式 soak 的这一 prerequisite，但不替代任何 100×30 正式轮次。
- 固定提交 `4bf889e` 后的另一轮真实持久 PTY 虽完成两个 canonical Run（usage 3010/122 与
  3132/68）、空 Tool surface 和精确 Event→Task→Daemon Run→runtime Run→Session/Trace 链，
  post-run 审计却发现保留的 raw runtime 含 Daemon `control.token` 与 Connector 私人绝对路径。
  generation 1 `audit-correction.json` 因而把整次尝试判为 `unproven`，且不回填原始 evidence；
  它不推翻上述 `2cc22fb` 历史证据，也不进入正式分母。
- fixture、readiness、live_action 和 soak 分层独立；blocked、ineligible、skipped、failed、
  uncertain 和 unproven 均不得从分母静默删除。
- 外部能力阻断只隔离相应 scene/lane。除非所有安全替代路径都耗尽，否则继续执行其余场景。

## 当前 checkpoint 的工程边界

- 同轮 image/file attachment 已可达，并已有 CAS/`MediaEvidence`/opaque workspace/ref 生命周期
  安全路径。显式 `generate_image` 现只接受可选 `mediaEvidenceId`，把唯一 inline Provider 图片
  有界解码和结构校验后先写 CAS/Session Evidence，再向 Session/Ledger 返回 ref-only result；
  Google edit fixture 已证明同 Session 后续 Run/重启的原始像素精确回取。普通 CLI/Daemon 的
  显式 `@media:media-evidence:sha256:<digest>` 也已接通同 Session CAS 重注入：Event/Session 只
  保存 ref，新附件与引用合计最多 8 项且 inline 合计最多 20 MiB；跨 profile/workspace/trust、
  篡改或不兼容 Provider 均在请求前拒绝，completed ledger 回放不读 CAS。OpenAI multipart edit、
  URL/multi artifact、隐式代词/跨 Session 连续性、语义 answer anchor、Memory 和 live 图片 Provider
  验收仍是阻断项；不得用 fixture/集成回归宣称完整图片产品闭环。
- `@audio` 首版 PCM16 WAV 已从有界摄取接到同一 Session actor 的本地 ASR port、derived
  transcript segment/time-range `MediaEvidence`、canonical Agent Run 与 `RunFinalization` anchor；
  相同 durable Task retry 复用派生 Evidence。该路径只有 Swift helper typecheck、合成 WAV、fake
  ASR 与 pipeline fixture，尚无真实 Speech 权限、真实用户音频、live Provider、设备或延迟 soak，
  也未接 MemoryCandidate，因此不得计为实机或 live 音频验收。非 WAV audio 与全部 `@video`
  继续网络前 blocked；视频音轨、关键帧、time-range 和理解 caller 尚未实现，未知 container/
  codec 保持 fail closed。
- Realtime transport/controller 是 transcription-only contract：没有 CLI/Daemon/Session actor
  composition root，也没有产品 mic source、speaker sink 或实机 stop/latency evidence。它不能被
  宣称为实时语音、双工、barge-in 或文本降级已经可用。
- conversation manifest 的 103 个场景与 3090 轮都是 declared，不是 executed。专用 no-tools
  RunPolicy、模型派发前空 Tool surface receipt 及 Event→Task→Run→Session/Trace/终端文件
  绑定已允许并完成隔离 S-lane PTY/1×1/2×5 calibration；W/F fixture、逐场景 action/oracle、
  完整 resume 与正式 100×30 soak 仍保持 Provider 前 `NO-GO`。
  `formalDenominatorTurns=0`，直到正式场景证据通过审计后才可更新；现有 calibration 与
  unproven 实际调用均不计入该正式分母。
- formal runner 的 headless 与持久 PTY model-turn 均已在输入前 durable `fsync`
  `turn_dispatch_started`；journal 首错永久 poison 并通过 dispatch barrier fail-stop，checkpoint
  由 single-writer `generation + sequence` 保证单调。SIGKILL 外置 credential owner/recovery、
  live 保留、PID reuse 回收及 hardlink/symlink fail-safe 已有确定性回归；models 仅投影严格生产
  schema 的单 Provider/单 Model、HTTPS 无 userinfo 配置，并只复制一个 key；PTY 仅从私有
  env 文件读取该声明 key 用于内存脱敏，异常在输入前拒绝。真实模式禁止 `--skip-build`；runtime closure
  绑定 clean HEAD、`dist/**`、Node executable、实际 `node_modules` 字节、runner helpers 和
  manifest，在启动前与 headless 每轮前后复核；PTY 当前仅在整体前后复核 closure，逐轮只有
  dispatch journal，不能扩大为逐轮 runtime identity 证据。
- 完整 resume、逐场景 action/fixture/oracle 的真实执行与 W/F 强制 Tool policy 仍未闭环，因而
  正式 100×30 soak 继续 `NO-GO`。exact Connector mode、evidence 根外 raw runtime 与 canonical
  hash archive 已完成本地工程验证，但没有产生新的 proven PTY；固定提交 `4bf889e` 后运行的
  两轮已按上述 retention 审计归为 `unproven`。既有 calibration-only 证据和该失败尝试均不计
  正式轮次，`formalDenominatorTurns=0`。
- 当前 checkpoint 已在代码与回归中加入：exact-empty Connector 初始化；evidence 根外 raw runtime
  owner/foreground-Daemon PID process-start identity 恢复与 bounded TERM/KILL；物理、内容绑定且纳入
  closure 的 Python interpreter identity；PTY timeout/`SIGTERM`/`SIGINT` child reap；永不产生 model
  proof 的 control-only purpose；保持 raw terminal 长度与 assistant offset 的私人路径等字节替换；
  以及 canonical index + generation-0 detached seal 后重新验证正 usage、唯一实体链、空 Tool
  surface、Connector receipt、helper/raw transcript 与 terminal byte range 的 strict prerequisite。
  这些工程事实已通过 97/97 聚焦回归、2/2 architecture budget、`npm run check`、1173/1173
  完整单测、manifest validation 与 `npm run build`；未运行 package smoke、完整 CI 或新的真实
  PTY，所以不得据此关闭 evidence 或 formal soak 门禁。
- CAS owner/ref/GC 已进入 production attachment path，并通过完整单测/coverage CI 以及进程
  终止、锁恢复、并发 owner、启动 reconcile 等确定性 fault-injection；真实掉电与长期配额/GC
  soak 仍未形成 promotion 证据。发生不确定恢复状态时必须保留 ref 并失败关闭，不能用 unit
  test 替代外部 soak。
- 现有 daemon backup/restore 尚未把 `attachments/` CAS/owner refs 和
  `session-workspaces.json` 放进同一恢复一致性协议。删除源数据后的 restore 可能保留
  Event/Session 中的 opaque ref，却丢失 blob 或 workspace 映射；因此 M3 product `GO`
  必须先升级 backup schema，并通过 backup -> 删除源 -> restore -> read/dispatch E2E。
