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
路径：同轮 image/file 可以进入现有模型路径；audio/video 只能摄取为稳定 ref 与
metadata-only Evidence，随后在 Provider 前诚实 blocked。Realtime 仅完成 transcription/VAD-only
transport/controller 和 Host runner contract，尚无 CLI、麦克风、播放器或 Session actor 的
composition root。图片生成结果 CAS 化、跨轮原图重注入、音视频分析、Memory 编译和真实
benchmark 仍按后续 Slice 执行，不能从 contract/unit test 推断为产品能力。

从该 checkpoint 继续补齐：

- 把 CLI attachment 已有的内容寻址 `MediaEvidence` 扩展到生成/编辑图片、真实音视频分析和
  Memory 编译；Session/Event/Memory 继续只保存稳定 ref、digest 和有界元数据，原始二进制、
  base64、PCM frame 不进入 JSON/SQLite 文本状态。
- 在现有批次摄取、MIME/kind、symlink/篡改、配额、owner ref 与 GC 基础上完成格式结构 probe、
  掉电/reconcile fault injection 和长期 soak；Daemon Event 继续不持久化私人绝对路径。
- 图片原图引用的多轮连续性；音频 transcript 时间片与 MemoryCandidate；视频音轨、关键帧、
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
       -> Slice 2: audio transcript/timeslice/MemoryCandidate
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
场景对应目标分母 3000，3 个为 supplemental）。runner 在可强制执行的逐场景 RunPolicy、
fixture/oracle 和完整证据绑定就绪前保持 Provider 前 `NO-GO`；因此
`realProviderTurnsExecuted=0`、正式分母为 0，manifest 校验和 PTY helper 均不计入真实轮次。

进度与客观阻断分别记录在 [PROGRESS.md](PROGRESS.md) 和 [BLOCKED.md](BLOCKED.md)。
