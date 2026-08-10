# M3 多模态交互实施计划

## 状态与裁决

- 权威范围：蓝图 JRV-301/302/303，即实时语音、图片/音频/视频理解、统一
  `MediaEvidence` 与跨入口连续性。
- 开发基线：`origin/codex/mimiagent-integrated` 的
  `9d2d7f0185d635a0599488e9f91660020ed9976e`，隔离分支
  `codex/m3-multimodal-benchmark-hardening`。
- M2 工程验收可关闭：owner 以 `--allow-wal` 授权的 100 问只读审计已经得到
  `auditStatus=complete`，证据以 `../m2/PROGRESS.md` 和 `../m2/BLOCKED.md` 为准。
- owner 明确授权在隔离分支并行启动 M3 工程。该授权只覆盖实现、fixture、隔离评测和
  可恢复的本地验证，不是主线合并、部署或产品 promotion 的 `GO`。
- 长期 Daemon/ARC-503 仍未关闭；最新不可变退出记录
  `../../../evals/m1/exit-records/20260803T180700+0800-no-go.json` 仍是 `NO-GO`。
  M3 不修改旧记录，也不以新代码或 fixture 覆盖该外部门禁。

## 已有基座与真实缺口

integrated 已有最多 8 个附件、多图片输入、原图 data URL 模型边界、图片生成/编辑
Media WorkUnit、macOS Screen OCR，以及分段 ASR、`say` TTS、wake phrase、音频文件转写和
Outbox 朗读。它们是可复用基座，不等于 M3 完成。

截至当前 checkpoint，Slice 0 已形成可运行的 CLI attachment / `MediaEvidence` / CAS 安全
路径：同轮 image/file 可以进入现有模型路径；`@audio` 的首版 PCM16 WAV 已从受控摄取延伸到
同一 Session actor 内的本地 ASR、派生 transcript segment/time-range Evidence、canonical Agent
Run 与 `RunFinalization` anchor；非 WAV audio 与 video 仍在 Provider 前诚实 blocked。显式
`generate_image` Media WorkUnit
也已把唯一 inline Provider 图片有界解码并结构校验到 CAS + Session Evidence，Tool result 只
返回 ref/digest；同 Session 后续 Run/重启可用 `mediaEvidenceId` 走 Google edit fixture 精确回取。
OpenAI edit 与跨 scope/tamper 在网络前失败关闭，URL/multi artifact output 在写入持久结果前拒绝。
普通 CLI/Daemon Conversation 也已支持显式
`@media:media-evidence:sha256:<digest>`：同 Session 重启后从 CAS 校验并重注入原图，Event/Session
仍只保存 ref；引用与新附件合计最多 8 项、全部 inline 图片合计最多 20 MiB。跨 profile/workspace/
trust、篡改或不支持 `imageInput` 的 route 在 Provider 前拒绝，completed ledger receipt 在 CAS
读取前回放。该证据仍是 fixture/集成回归，不是 live Provider，也不实现代词推断或跨 Session 引用。
WAV 路径当前只有 Swift helper 与合成 fixture 证据，没有真实 Speech 权限、用户音频、live
Provider 或延迟 soak；MemoryCandidate 也未接入。Realtime 仅完成
transcription/VAD-only transport/controller 和 Host runner contract，尚无 CLI、麦克风、播放器或
Session actor 的 composition root。上述图片证据仍是 unit/adapter fixture，不是 live Provider；
普通聊天媒体续指、其它音频格式、视频分析、Memory 编译和正式 benchmark 仍按后续 Slice 执行。

从该 checkpoint 继续补齐：

- 把 CLI attachment、显式 `@media` 引用和生成/编辑 Tool 已有的内容寻址 `MediaEvidence`
  扩展到隐式代词/事项连续性、真实音视频分析和 Memory 编译；Session/Event/Memory/Ledger
  继续只保存稳定 ref、digest 和有界元数据，原始二进制、base64、PCM frame 不进入
  JSON/SQLite 文本状态。
- 在现有批次摄取、MIME/kind、symlink/篡改、配额、owner ref 与 GC 基础上完成格式结构 probe、
  掉电/reconcile fault injection 和长期 soak；Daemon Event 继续不持久化私人绝对路径。
- 图片的跨 Session/入口事项连续性、隐式代词解析与语义 answer anchor；在现有 WAV transcript
  时间片基础上补 MemoryCandidate、其它 eligible 音频格式与实机验收；视频音轨、关键帧、
  时间片和 coverage。
- 模型与设备能力的诚实路由。旧模型配置向后兼容，新 audio/video/realtime 能力默认
  `false`；不支持的 provider/adapter 必须在网络请求前 fail closed 或明确降级。
- 同一 Session actor 内的实时语音生命周期、流式 ASR/TTS、turn detection、barge-in、
  文字降级和资源释放。音频 delta 不得各自创建 Run，也不得引入第二个 Session owner。
- 文本、图片、语音和视频入口继续同一事项时的幂等：不重复 Task、Memory 或外部 effect；
  重连和恢复继续服从 run ownership、tool-call pairing 与 Effect Ledger。

## 不变量

- 一个主 Agent、每个 user-facing Session 一个 owner；Realtime transport 只能作为现有
  Session actor 的 I/O adapter，不能并列创建第二套 agent/history/tool loop。
- Session 保留完整协议单元，裁剪不能拆散
  `user -> function_call -> function_call_result -> assistant`。
- active Run 写入按不可变 `sessionId/runId` 校验；旧 Run、断线音频和 stop ack 后到达的 frame
  均不得写入。
- JSON/SQLite 继续通过既有 schema 和原子 store；媒体 blob 使用独立 artifact 生命周期。
- side effect 结果为 uncertain 时不自动重放或换 Provider；外部事件内容仍是不可信数据。
- M3 不建设后台常开麦克风、摄像头或实时屏幕采集；关闭后须立即停止采集并释放资源。

## 实施 DAG

```text
owner override + clean baseline
  -> Slice 0: binary firewall + MediaEvidence + artifact lifecycle
       -> model/device/media capability truth
       -> Slice 1: multi-image original-reference continuity
       -> Slice 2: PCM WAV transcript/timeslice [engineering reachable]
                   + MemoryCandidate/other formats/live acceptance
       -> Slice 3: realtime voice/turn detection/barge-in/text fallback
       -> Slice 4: video audio/keyframe/timeslice/coverage
  -> cross-entry continuity + reconnect/recovery/idempotency
  -> fixture/readiness/live_action/soak evidence + full-product regression
```

每个 Slice 先提交失败测试或可复现证据，再做最小补丁。风险递增验证顺序为 focused tests、
`npm run check`、`npm test`、`npm run build`、package/CI。不得直接编辑 `dist/`。

## Realtime adapter 硬边界

- 当前 SDK 正式入口是 `@openai/agents/realtime`；不直接依赖或导入传递包
  `@openai/agents-realtime`。新增入口须加入 package smoke。
- Node transport 只有 WebSocket，麦克风 PCM source 和播放器 sink 由 Mimi 管理；SDK
  `RealtimeSession` 不得成为第二个 Agent、Session owner、tool/history loop。
- 首版只允许 transcription/VAD：`createResponse=false`、Provider output audio 为 `null`、
  tools 为空。final transcript 进入现有 canonical Mimi Run；只有该 Run 的 assistant text 可以
  交给 Mimi-owned TTS，禁止并列播放 Realtime LLM 的第二份回答。
- adapter 只有在连接态确认后才接收音频；断连 frame 明确拒绝，不依赖 SDK
  `sendAudio()` 的静默丢帧行为。输入固定为 24kHz PCM16 的 20ms frame（960 bytes），严禁
  把完整音频段一次送入 SDK 的 base64 转换。
- WebSocket transport 不支持 `mute(true)`；静音和 stop 必须停止本地采集。`speech_started`
  只中断 Mimi-owned TTS 并在安全边界取消旧 canonical Run，不创建或截断 Provider 回答音频。
- stop/close 要有界等待采集器、播放器和 transport 的 Mimi-owned ack；SDK `close()` 本身不
  作为资源已释放证据。当前这些是 transport/controller contract，产品接线和实机指标未完成。

## M3 验收契约

- 至少 50 个确定性媒体 fixture 和 30 个真实分层会话；实时语音另有至少 100 个真实轮次。
- 图片结论 100% 可定位原图；音频/视频关键结论 100% 可定位时间片或关键帧；hash 可复验。
- 持久状态中的 base64/raw frame 数量为 0；不支持能力在发出模型网络请求前
  `blocked/degraded`，不得静默丢弃非图片附件。
- 实时语音转写、回复和播放闭环成功率至少 95%；打断停止播放 p95 不高于 750ms，并分别
  报告 turn detection、首个音频 delta、设备首个可听帧和 stop ack。
- stop ack 后零新 frame，采集器、播放器和连接均释放；重连不重复 Task、Memory 或 effect。
- evidenceKind 必须严格区分 `fixture | readiness | live_action | soak`；blocked、ineligible、
  skipped、uncertain 均保留在分母说明中，不伪造成成功。

## 100×30 全产品终端基准

该基准是 M3 之外的全产品回归门禁：不少于 100 个唯一场景，每场景在同一 Session 严格串行
不少于 30 个真实 user turn，总计不少于 3000。正式 soak 前先保留一次真正持久交互
`tty:true` 的 Mimi PTY smoke；大规模 lane 可以逐轮使用非交互 CLI，但必须明确称为走同一
CLI -> Daemon -> Provider 路径的自动化终端基准，不能混称 PTY。

每轮必须有唯一 `SCENE/TURN/NONCE`，且同时证明终端输入输出、Trace 的
`turn_start -> model_binding_event(workUnitKind=conversation) -> turn_end/error`、Run 终态和
非零 usage、Session 恰增的 user/assistant 协议单元及 tool call/result 配对。直接调用内部
纯函数、静态 fixture、伪造 transcript 和现有 `bench:capacity` 均不计入真实轮次。

夜间默认只开放 Safe 真模型只读、临时 workspace 写和本地 fixture 全链路；VM/专用 OS 用户
和受监督 live lane 在宿主无人值守时 ineligible。真实 Connector、消息、日历和 GUI 写动作仅在
已有精确安全目标与可验证回执时执行。P0、写入 uncertain、临时根外 diff、真实 Connector
回执或 secret 命中会全局停止派发且不重试。

当前 manifest 含 103 个场景、每场景 30 个声明轮次（3090 declared turns，其中 100 个 core
场景对应目标分母 3000，3 个为 supplemental）。runner 的 headless 和持久 PTY model-turn 均在
输入前同步、`fsync` 写入 `turn_dispatch_started`；`DurableJournalWriter` 首次 I/O 错误后永久
poison 并由 dispatch barrier 停止后续派发，checkpoint 由 single-writer
`generation + sequence` 保证单调。Provider 凭据位于 evidence bundle 外的 owner-bound 私有根，
SIGKILL 后按 PID start identity 恢复，live owner 保留、PID reuse 回收，hardlink/symlink 异常
失败关闭。models 配置只接受严格生产 schema 投影出的单 Provider/单 Model、HTTPS 且无
userinfo，并只复制一个选中的 key；PTY 只从外置 `0600` env 文件读取该声明 key 用于内存
脱敏，缺失、权限或 link 异常在输入前失败关闭。真实模式禁止 `--skip-build`，runtime closure
绑定 clean HEAD、完整 `dist/**`、Node
可执行文件、实际 `node_modules` 文件字节、runner helpers 与 manifest，并在启动前、headless
每轮前后及 PTY 整体前后复核。PTY 当前只有逐轮 durable journal，closure 仍是整个 PTY smoke
前后复核，不应写成逐轮 closure 证明。

本计划统一使用三套不可互换的计数：`actualRealProviderTurnsExecuted` 统计确实到达真实 Provider
的调用，不论最终证据 proven 与否；`provenCalibrationTurns` 只统计通过完整 calibration/
prerequisite 审计、但明确不进入正式场景分母的轮次；`formalDenominatorTurns` 只统计通过正式
100×30 场景合同的轮次。某次 manifest validation 输出的 `realProviderTurnsExecuted=0` 仅说明该
validation 命令没有派发模型，不能作为累计历史计数。

固定提交 `4bf889e` 后曾执行一次新的真实两轮持久 PTY：两个 canonical Run 的 input/output
usage 分别为 3010/122 与 3132/68，空 Tool surface 与
Event -> Task -> Daemon Run -> runtime Run -> Session/Trace 精确链路均通过功能核验。但 post-run
审计发现 evidence bundle 仍保留 raw Daemon `control.token`，且初始化后的 Connector config
包含私人绝对路径，因此该整次尝试通过 append-only、generation 1 的 `audit-correction.json`
判为 `unproven`，不回填原始 evidence，也不计任何正式轮次。该结论不改写固定提交 `2cc22fb`
已经关闭的历史 PTY prerequisite。截至该 correction，累计
`actualRealProviderTurnsExecuted=20`、`provenCalibrationTurns=13`，而
`formalDenominatorTurns=0`。

修复方向为 exact Connector config mode、evidence 根外的 raw runtime，以及只导出可重算哈希的
canonical Event/Task/Run/Session/Trace/terminal archive。当前 engineering checkpoint 已加入物理且
内容绑定的 Python interpreter identity；timeout/`SIGTERM`/`SIGINT` 后 bounded child process-group
reap；只允许 terminal action、且永不产生 model proof 的 PTY control purpose；保持 terminal
字节长度与 assistant offset 的私人路径等字节替换；foreground Daemon PID/process-start identity
恢复；以及 generation-0 detached seal 后重新逐字节/逐实体核验的 strict PTY prerequisite。本批
已通过 97 项聚焦回归、2 项 architecture budget、`npm run check`、1173 项完整单测、manifest
validation 和 `npm run build`；没有执行新的真实 PTY 或 Provider 调用，因此不增加 proven 计数。

完整 resume、逐场景 action/fixture/oracle 执行和 W/F 强制 Tool policy 仍未闭环；正式
Provider soak 因此保持 `NO-GO`。上述 `4bf889e` 两轮为 post-run 审计不成立的 `unproven`
尝试；既有 calibration-only 证据与该失败尝试均不计入正式轮次，
`formalDenominatorTurns=0`。

进度与客观阻断分别记录在 [PROGRESS.md](PROGRESS.md) 和 [BLOCKED.md](BLOCKED.md)。
