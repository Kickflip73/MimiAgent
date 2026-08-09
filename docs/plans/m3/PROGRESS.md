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

## 2026-08-10 no-tools calibration checkpoint 与真实执行证据

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
- 第一次持久 PTY 尝试在 Daemon readiness 阶段、任何模型请求前暴露了旧启动检查：它仍按
  AppConfig 硬要求 `OPENAI_API_KEY`，忽略 models registry 的 global target。启动检查现与实际
  registry Provider 的 `apiKeyEnv` 对齐；legacy 配置行为不变，校准根另固定 lexical memory，
  不复制第二个 credential。该失败运行保留在隔离临时证据根，不计任何轮次。
- 第二次持久 PTY 尝试确认 `tty=true`、启动 prompt 和两个真实 Provider Run；两个 Run 分别有
  2969/242 与 3001/1488 input/output tokens，并由 helper 独立看到 completed、正 usage 和
  busy -> prompt-ready。但 manifest prompt 是多行，旧 helper 将内部换行当作多个 Enter，额外
  创建第三个 Run，导致 Session/Trace/assistant-visible 总体审计失败。整个尝试标为
  `unproven`，成功 PTY/calibration 轮次仍为 0；修复改用 bracketed paste 后单独发送 Enter，
  并用完整写循环防止 PTY partial write。
- 第三次 PTY 尝试没有创建 Run 或发出 Provider 请求：终端正确保留了一个完整多行草稿，但
  paste-end 与 Enter 进入同一 PTY 读取批次，paste 处理返回时丢弃了尾随 Enter。helper 现把
  start/data/end 分开完整写入，并在独立的下一批发送 Enter；该尝试同样为 `unproven`、0 轮。
- 第四次 PTY 尝试真实完成 2 个 Run（3196/803 与 3906/237 input/output tokens），TTY、usage、
  两个空 Tool surface receipts、Session/Trace nonce、无 active Run 和正常 `/exit` 均通过；最终
  因终端渲染插入行首 gutter 导致 canonical assistant 字面查找失败，整次仍标为 `unproven`。
  PTY prerequisite 现使用专门的两轮 no-tools prompt，不再复用带 fixture/target 语义的正式场景
  action；终端证明按 Buffer 字节 offset 切片，只剥离已知 busy redraw/input gutter，并要求命中
  不存在于输入回显中的 canonical assistant 独有片段；该修复不能追认第四次尝试。
- 固定提交 `2cc22fb` 上的第五次真实持久 PTY 已通过：同一 Session 的 2 个 Run 均为
  `completed`，usage 分别为 3022/61 与 3138/69 input/output tokens；TTY、启动、transport
  chunks、Run 后 prompt-ready、空 Tool surface receipts、canonical assistant 可见性、正常
  `/exit` 与 secret hits=0 全部闭合。该证据只关闭 PTY prerequisite，不计 3000 轮正式分母。
- 随后的首个 headless 1×1 calibration 真实完成一个 Provider Run（3185/599 tokens），但以非零
  退出并记为 `unproven`：runner 把 `daemon show task` 的权威诊断投影
  `taskId/sessionId/authorityEventId` 错当成持久字段 `id/sessionKey/triggerEventId`，因此没有回取
  Event。审计边界现显式归一化两种字段并拒绝冲突；该失败证据不可追认为通过，需新目录重跑。
- 固定提交 `104dff6` 的新隔离根 1×1 重跑已通过：`conv-008` 为 1 proven/0 unproven，
  Event→Task→Daemon Run→runtime Run→Session/Trace 全链闭合，usage 为 3183/1087 tokens，
  Tool calls、pending Task/Outbox/active Run、source-tree drift 与 secret hits 均为 0。它仍是
  calibration-only、正式分母 0。运行同时暴露单轮结束时 USD checkpoint 沿用派发前数值的问题；
  现已在每轮 usage 入账后刷新显式估算，再进入 2×5。
- 固定提交 `37dceea` 的 2 场景×5 轮校准已通过：`conv-008` 与 `conv-010` 各 5 轮，
  合计 10 proven/0 unproven、38757/3299 input/output tokens、0 Tool calls、0 leak flags、
  0 secret hits；按明确配置的保守估算费率为 2.59765 美元（不是账单价格）。10 条链使用
  10 组唯一 Event/Task/Daemon Run/runtime Run ID，70 份 terminal/Event/Task/Run/Session/Trace
  文件逐字节重算为 0 mismatch。随后 `npm test` 为 1032/1032，`npm run build` 退出 0。
  去敏机器报告见 `evals/conversation/calibration-report.v1.json`；全部仍为 calibration-only，
  100×30 正式执行保持 NO-GO、正式分母 0。
- 本 checkpoint 的 no-tools focused tests 为 133/133；registry credential 修复后的相关 focused
  tests 为 20/20，随后完整 `npm test` 为 1029/1029，`npm run check` 与 `npm run build` 均
  退出 0。这组数字是实际派发前的工程门禁证据；成功的持久 PTY、1×1 与 2×5 calibration
  以上述固定提交和独立证据根为准，仍不进入 100×30 正式分母。

## 2026-08-10 图片 Media WorkUnit 闭环 tranche

- `generate_image` 的公开 Tool schema 已移除 raw `image`，只接受 prompt 与可选的同 Session
  `mediaEvidenceId`；legacy raw image/data URL 在 Execution Ledger 建立记录前拒绝。
- Provider 输出只接受唯一 inline canonical base64 图片。Runtime 先做 10 MiB 上限预检、解码、
  MIME 与结构校验，再写 CAS、注册带真实 Run binding/lineage 的 Session `MediaEvidence`，最后
  返回 ref/digest/anchor。URL-only、多 artifact、小图或大于 ledger inline 阈值的合法图片都不会
  以 base64 或 `output_truncated` 进入 Session/Ledger。
- 同一 Session 的后续 Run 与进程重启可用 `mediaEvidenceId` 重新校验 CAS，并在 Google edit
  请求边界短暂物化完全相同的原始像素；跨 Session、跨 workspace、不存在或被篡改的 ref 均在
  Provider 前拒绝。OpenAI edit 因缺少 multipart adapter 继续网络前 blocked。
- 普通 CLI/Daemon Conversation 已接通显式
  `@media:media-evidence:sha256:<digest>`：ChatClient 把 token 转为 immutable Event 中的
  `referencedMediaEvidenceIds`，Dispatcher/Run 在同一 Session/profile/workspace/trust 下验证 Evidence
  与 CAS 后临时构造 `input_image`，Session 与 Event 不保存 data URL。重启可恢复；引用与新附件
  合计最多 8 项，全部 inline 图片合计最多 20 MiB。跨 scope、篡改和不兼容模型均在 Provider 前
  拒绝；completed execution receipt 在 CAS materializer 前回放，零 artifact read/Provider call。
- `providerRoute` 和 backup failover 现在必须解析到当前 registry 的精确模型，并以真实 capability
  满足冻结 WorkUnit；任意模型名不再被推定支持 image/file，未注册或不兼容 route 在网络前移除。
- 当前证据是 image/media unit、真实 adapter payload 与本地 fixture 回归，不是 live 图片
  Provider 验收。显式 `@media` 有 CLI→Event→Dispatcher→真实 pipeline 集成回归，但隐式代词、
  跨 Session、语义 answer anchor、Memory 编译、remote URL 与多 artifact 仍未完成；本 tranche
  不改变正式 100×30 分母 0 或产品门禁状态。
- 本 tranche 门禁已完成：`npm run check` 退出 0；完整 `npm test` 为 1062/1062、0 fail，耗时
  116.2 秒；`npm run build` 与 `npm run test:package` 均退出 0。conversation manifest 校验仍为
  103 scenarios / 3090 declared turns，`realProviderTurnsExecuted=0` 且 formal `NO-GO`；这些
  工程/fixture 测试不计 live 图片验收或 100×30 正式轮次。
- 最终文件集的 `npm run ci` 也退出 0：repository hygiene、release consistency、依赖方向与
  asset boundary 均通过，coverage 套件 1062/1062，整体 line/branch/function 覆盖率分别为
  89.27% / 79.18% / 85.64%，随后 clean build 与 packed-package smoke 通过。ARC-303
  完整生产面为 8443/8505，未上调门限，保留 62 行余量。

## M3 能力审计

| 区域 | 已有可复用能力 | 尚未证明/实现 |
|---|---|---|
| 图片 | 同轮多图输入；CLI attachment 已有 CAS ref/Evidence；`generate_image` 输出 ref-only；Google edit fixture 与普通 CLI/Daemon 显式 `@media` 均可按同 Session Evidence 跨后续 Run/重启精确回取 | live 图片 Provider；OpenAI multipart edit；隐式代词/跨 Session 连续性；语义 answer anchor、Memory、URL/multi artifact |
| 语音 | 既有 2～30 秒分段 ASR、`say` TTS、wake phrase、文件转写；新增 transcription-only transport/controller contract | CLI/mic/speaker composition；真实 turn detection、barge-in、低延迟、断线与文本降级 |
| 音频 | `@audio` 有界摄取并在 Provider 前诚实 blocked；Evidence schema 支持 transcript anchor | 生产 ASR caller、时间片、真实 model binding/coverage 与 MemoryCandidate |
| 视频 | `@video` 有界摄取并在 Provider 前诚实 blocked；Evidence schema 支持 keyframe/time-range anchor | 音轨提取、关键帧、时间片、有界理解、可信 adapter receipt 与诚实 coverage |
| 连续性 | Session/run ownership 与 Effect Ledger 基座 | 跨文本/图片/语音/视频入口事项幂等、重连/恢复不重复 |
| Eval | 既有 unit、M1、Browser/Computer E2E、103 场景 declared manifest；持久 PTY prerequisite 与 1×1/2×5 calibration 已有可审计真实 Provider 证据 | 各正式场景的可执行 fixture/oracle 与真实 Provider 100×30 基准原始证据 |

## 阶段状态

- Slice 0（CLI attachment binary firewall、MediaEvidence、artifact lifecycle）：checkpoint 实现、
  完整单测、coverage CI、构建与 package smoke 已绿；外部掉电/长期 soak 未完成，不能宣称
  promotion gate 通过。
- Slice 1（多图原图引用）：同轮可达；显式 `generate_image` 输出和同 Session
  `mediaEvidenceId` Google edit 的 CAS/ref-only 跨 Run/重启闭环已由 fixture 验证；普通 CLI/Daemon
  显式 `@media` 也已通过 Event/Dispatcher/真实 pipeline 集成回归。隐式代词、跨 Session 连续性、
  语义 answer anchor、Memory 与 live Provider 验收仍待实现。
- Slice 2（音频时间片与 MemoryCandidate）：待实现。
- Slice 3（实时语音）：transport/controller 合同已固定但产品不可达；CLI/mic/speaker 与
  Session actor composition、实机延迟/释放证据待实现。
- Slice 4（视频）：待实现。
- 连续性/恢复：待实现。
- M3 媒体 fixture/live 验收：当前新增证据仍为 unit/adapter fixture，没有 live 图片或实时语音
  轮次；实时语音真实轮次为 0。
- 100×30 全产品真实终端基准：103 场景/3090 轮 manifest 仅完成静态声明与验证，
  no-tools S-lane 已完成持久 PTY prerequisite 与 1×1/2×5 calibration，但这些 calibration-only
  轮次不计正式分母；`realProviderTurnsExecuted=0`、正式分母为 0。现有
  `bench:capacity` 的 100 rounds 不走真实 Provider，永不计入该分母。

后续每次长跑应追加记录 manifest digest、build identity、seed、场景/轮次分母、Provider/model、
usage、失败严重度、blocked/ineligible 原因、证据根和恢复 checkpoint；没有原始证据的轮次标为
`unproven`，不得补写为成功。
