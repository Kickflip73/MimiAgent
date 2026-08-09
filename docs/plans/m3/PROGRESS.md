# M3 多模态交互 Progress

## 2026-08-09 开工检查点

- owner 裁决：M2 工程验收已完成，允许隔离启动 M3；不把该裁决表述为主线
  merge/deploy/promotion `GO`。
- 基线：`origin/codex/mimiagent-integrated` 的
  `9d2d7f0185d635a0599488e9f91660020ed9976e`；分支
  `codex/m3-multimodal-benchmark-hardening`。
- 隔离：原主工作区的 tracked Terminal UI 改动和个人音频产物不在本工作树中，也不纳入
  本任务 diff、fixture 或证据。
- 门禁核对：`../m2/PROGRESS.md` 已记录 allow-WAL 后 owner 100 问
  `auditStatus=complete`；`../m2/BLOCKED.md` 明确 M2 工程验收可关闭。长期 Daemon/ARC-503
  仍未关闭，最新 M1 不可变退出记录仍为 `NO-GO`。

## 基线与首个回归

- 隔离基线 `npm run check`：退出 0。
- 隔离基线 `npm test`：946 tests / 945 pass / 1 fail / 0 skipped / 0 todo。唯一失败是
  `owner natural-language runs retain direct tools and unified deferred Skill discovery`：24 个
  首轮 schema 估算 4046 tokens，超过 4000 上限 46。
- 隔离基线 `npm run build`：退出 0。
- 根因：SDK 生成的每个 model-facing Tool parameters 都重复顶层 JSON Schema dialect
  `$schema`；该字段不增加值约束，却消耗首轮上下文。
- 最小补丁：只对交给模型的 Tool 浅拷贝 parameters 并删除顶层 `$schema`；原 Tool、Zod
  parser、invoke closure、权限和 deferred gateway 均不变。首轮预算由 4046 降为 3734，
  保留 266 tokens 余量。
- 新增聚焦语义回归：模型 Tool 无 `$schema`、原参数对象未 mutation、合法参数仍调用原
  execute、非法参数仍由原 Zod parser 拒绝、owner 首轮预算不高于 3800。
- 最初聚焦命令为 2 tests / 2 pass / 0 fail；该修复随后已进入本页记录的完整
  `npm test` 与 `npm run ci` 绿态，不再只依赖聚焦证据。

## 2026-08-10 Slice 0 checkpoint

- CLI 附件输入扩展为 `@image/@file/@audio/@video`，只接受 local-cli owner 的受控字段；
  `payload.attachments`、外部来源、本地绝对路径泄漏、symlink/containment、名称/MIME/kind、
  摘要与数量/大小边界均失败关闭。
- 新增内容寻址 `MediaArtifactStore` 与统一 `MediaEvidence`。Event/Session 持久化 opaque ref、
  digest、结构化 anchor 和有界 metadata；二进制与私人 workspace 绝对路径不进入 Event JSON。
  批次 staging、Event/Session owner refs、共享 blob、配额、grace GC 与 Run/Session/workspace
  provenance 已接入生产 attachment path。完整掉电/长期 soak 仍是后续 promotion 门禁。
- 新 Session 通过原子 registry first-bind 到物理 workspace realpath；Event 仅携
  `workspace:<uuid>`，Dispatcher 在 Host 内解析。已有 Session 省略 workspace 参数时继续使用
  原绑定，不能被后续 submit 静默重绑到另一项目。
- 同轮 image/file 仍走现有 Provider input 路径；audio/video 被识别并持久摄取，但分析能力
  尚未接入，模型请求前明确 blocked。fixture 中的 transcript/keyframe/time-range schema 不算
  生产 ASR 或视频理解。
- Realtime transport/controller 已固定官方 route/model、20ms PCM frame、连接/停止 deadline、
  transcription/VAD-only `createResponse=false`、Provider output audio 禁止，以及 final transcript
  进入 canonical Host Run、canonical answer 交给 Mimi TTS 的合同。它没有 CLI/Daemon/设备
  composition root，真实实时语音轮次仍为 0。
- conversation manifest 当前为 103 scenarios / 3090 declared turns / 10 suites；runner 校验会
  报告 `realProviderTurnsExecuted=0`。专用 `benchmark-no-tools-v1` RunPolicy 现已从认证
  local-cli owner Event 贯穿到冻结 Run，并在模型派发前把精确 `advertisedTools=[]`、Run/Session
  归属和摘要写入 Trace；只有 S-lane no-tools calibration 因此解除工程门禁。它还没有真实执行，
  也不是 PTY smoke 或正式 benchmark，正式分母仍为 0。
- 冻结 checkpoint 后的完整 `npm test`：1023 tests / 1023 pass / 0 fail / 0 skipped /
  0 todo，耗时 116.203 秒。`npm run check`、`npm run build` 与 `npm run test:package`
  均退出 0。
- 完整 `npm run ci` 通过：repository/release/dependency/asset-boundary hygiene、严格类型检查、
  1023 个 coverage tests、干净构建和 packed-package smoke 全绿；总覆盖率为
  88.96% lines / 78.84% branches / 85.41% functions。CI 首轮还发现 integrated 基线已跟踪的
  `meeting-notebooklm-km-skill` 未进入 `skills/manifest.json`，现按未发布 experimental Skill
  分类并由同一 asset-boundary gate 验证。
- ARC-303 完整生产面为 8294 行，低于 8505 门禁，保留 211 行余量；没有上调预算。

## 2026-08-10 no-tools calibration checkpoint（待真实执行）

- 空 deferred surface 不再生成 `inspect_capabilities` / `invoke_capability` gateway；fake Runner
  从真实 pipeline 捕获的 SDK Tool 列表严格为空。
- 校准策略只能由认证 `local-cli` + `owner` 的顶层 RPC 参数请求；payload 字段注入、外部来源、
  未绑定 Session 和未知策略版本均在 Event 持久化前失败关闭。
- 每次模型派发前同步写入 `model_tool_surface` Trace receipt；写入失败会阻止 Provider 调用。
  headless 与 PTY 审计均要求该 receipt 与 Event -> Task -> Daemon Run -> runtime Run -> Session
  全链、正 usage、终端原始字节和哈希严格对账。
- runner 只投递 100 场景矩阵中声明为 S/headless/no-tools 的校准场景；W/F/V/L 与正式 soak
  继续失败关闭。Provider 配置被投影为单一 Provider/Model，临时 `MIMI_ENV_FILE` 只保存一个
  选中 key 且权限为 0600，Daemon 停止后覆盖删除；通用环境 allowlist 被禁止。
- 源码快照在 daemon 前、每次派发前和每轮后按实际文件内容复核；build identity 覆盖完整
  `dist/**`、runner、contract、PTY helper、manifest 和 package lock。任何 unproven 轮次均使
  命令非零退出。
- 本 checkpoint 的 focused tests 为 133/133；随后完整 `npm test` 为 1028/1028，
  `npm run check` 与 `npm run build` 均退出 0。此处仍是工程门禁证据：持久 PTY、1-turn 和
  2x5 真实 Provider calibration 尚未运行，`realProviderTurnsExecuted=0`。

## M3 能力审计

| 区域 | 已有可复用能力 | 尚未证明/实现 |
|---|---|---|
| 图片 | 同轮多图输入；CLI attachment 已有 CAS ref、Evidence、workspace/run provenance 与生命周期 | `mediaEvidenceId` 跨轮原图重注入；生成/编辑输入输出在 ledger 前 CAS 化；answer anchor |
| 语音 | 既有 2～30 秒分段 ASR、`say` TTS、wake phrase、文件转写；新增 transcription-only transport/controller contract | CLI/mic/speaker composition；真实 turn detection、barge-in、低延迟、断线与文本降级 |
| 音频 | `@audio` 有界摄取并在 Provider 前诚实 blocked；Evidence schema 支持 transcript anchor | 生产 ASR caller、时间片、真实 model binding/coverage 与 MemoryCandidate |
| 视频 | `@video` 有界摄取并在 Provider 前诚实 blocked；Evidence schema 支持 keyframe/time-range anchor | 音轨提取、关键帧、时间片、有界理解、可信 adapter receipt 与诚实 coverage |
| 连续性 | Session/run ownership 与 Effect Ledger 基座 | 跨文本/图片/语音/视频入口事项幂等、重连/恢复不重复 |
| Eval | 既有 unit、M1、Browser/Computer E2E 与 103 场景 declared manifest | 可执行 fixture/oracle、持久 PTY smoke、真实 Provider 100×30 基准与原始证据 |

## 阶段状态

- Slice 0（CLI attachment binary firewall、MediaEvidence、artifact lifecycle）：checkpoint 实现、
  完整单测、coverage CI、构建与 package smoke 已绿；外部掉电/长期 soak 未完成，不能宣称
  promotion gate 通过。
- Slice 1（多图原图引用）：同轮可达；跨轮 `mediaEvidenceId` 重注入与生成图片 CAS 闭环待实现。
- Slice 2（音频时间片与 MemoryCandidate）：待实现。
- Slice 3（实时语音）：transport/controller 合同已固定但产品不可达；CLI/mic/speaker 与
  Session actor composition、实机延迟/释放证据待实现。
- Slice 4（视频）：待实现。
- 连续性/恢复：待实现。
- M3 fixture/live 验收：尚未开始有效 live 计数，实时语音真实轮次为 0。
- 100×30 全产品真实终端基准：103 场景/3090 轮 manifest 仅完成静态声明与验证，
  no-tools S-lane calibration 已具备可审计派发门禁但尚未执行；
  `realProviderTurnsExecuted=0`、正式分母为 0；现有
  `bench:capacity` 的 100 rounds 不走真实 Provider，永不计入该分母。

后续每次长跑应追加记录 manifest digest、build identity、seed、场景/轮次分母、Provider/model、
usage、失败严重度、blocked/ineligible 原因、证据根和恢复 checkpoint；没有原始证据的轮次标为
`unproven`，不得补写为成功。
