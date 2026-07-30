# Progress

## 2026-07-30 systemic architecture repair kickoff
- Goal: reduce the deep live-eval failures to shared architectural causes, then repair at least the first three with generic red-to-green contracts.
- Priority: real completion/runtime stability, then state consistency/diagnostics, then cost, then breadth.
- Branch: created `codex/mimi-systemic-architecture-repair` from detached `325af70` before task-owned file changes.
- Baseline ownership: all inherited tracked and untracked working-tree changes remain user-owned and must be preserved.
- Evidence: all eight frozen eval inputs exist under the read-only `20260729-deep-live-eval` directory.
- Baseline failure: `npm run check` exited 127 (`tsc` missing); 10 focused files loaded 0 tests because `tsx` was missing.
- Largest risk: overlapping inherited runtime changes make per-file attribution and independent commits harder; use path-level diff review and narrow staging.
- Next: restore lockfile-declared dependencies without changing manifests, rerun baseline, freeze the root-cause plan, then implement in dependency order.

## 2026-07-30 restored code baseline
- `npm ci` restored 115 lockfile-declared packages and its prepare build passed; manifests and lockfile were not changed.
- `npm run check` passed after dependency restore.
- Focused baseline passed 121/121 across Daemon store/recovery/retry, Goal completion, Ledger, Memory, run pipeline/service, and tool policy; skip/todo=0.

## 2026-07-30 root-cause plan frozen
- Five evidence/source chains are reconciled into eight generic roots in `docs/plans/20260730-MimiAgent-systemic-architecture-repair.md`.
- Implementation order is R1 lifecycle truth, R2 typed failure disposition, R3 atomic revisioned Goal, then R4 canonical finalization/Tool manifest.
- The plan explicitly treats the maintenance/exit adjacency as non-causal and separates frozen eval builds from the current source baseline.

## 2026-07-30 R1 daemon lifecycle truth
- Red: `tests/daemon-lifecycle.test.ts` failed at load because the durable lifecycle contract did not exist.
- Green: lifecycle unit + Daemon CLI/IPC/build/recovery focused suite passed 30/30; `npm run check` passed.
- Result: owner shutdown, signal/failure, orphan recovery, supervisor/build/pid/worker and offline last-state diagnostics now share one bounded atomic epoch history; no Task replay was added.

## 2026-07-30 R2 typed failure disposition
- Red: the retry-policy test could not load the missing typed failure contract.
- Green: typed state-conflict/unsupported and structured transient scenarios passed; focused retry/recovery/provider/run-service suite passed 31/31 and `npm run check` passed.
- Result: retry now consumes phase/kind/retryable/dispatchStarted, typed facts outrank transport status, unclassified errors execute once, and natural-language error text no longer routes retries.

## 2026-07-30 R3 atomic revisioned Goal
- Red: both aggregate scenarios failed because `createGoal`/revision CAS did not exist.
- Green: conflict-create/stale-update and continue/cancel scenarios passed 2/2; expanded Goal/Completion/core/run suite passed 113/113 and `npm run check` passed.
- Result: prepared Contract + Goal setup is one PlanStore commit; active Goals cannot be overwritten, mutations require goalId/revision, cancel is explicit/idempotent, and free-text equality no longer grants resume ownership.

## 2026-07-30 R4 canonical finalization and Tool manifest
- Red: both file-mutation and shell/external-effect scenarios failed to load because no finalization projection existed.
- Green: finalization/journal/run-service/recovery/dispatcher focused suite passed 29/29 and `npm run check` passed.
- Result: ExecutionLedger remains the raw Tool fact source; one payload-free digest manifest and answer digest are persisted identically in the commit journal, completion receipt, trace, Agent result, and durable Task result.
- Recovery rejects receipt/journal drift; tests prove file/edit and shell/uncertain variants, receipt-to-trace equality, and Task propagation without copying raw arguments, outputs, or errors.

## 2026-07-30 R5 capability snapshot contract audit
- The post-eval source already constructs both the model request and status snapshot from the same final Tool array; no production branch was needed.
- Added two architecture scenarios (general Workstation and Plan Full Owner) proving status Tool IDs equal the actual model-facing request and available Tool items.

## 2026-07-30 R6 Memory blob/provenance atomicity
- Red: exact-repeat content from two Runs raised `Raw evidence 内容寻址冲突`; the failure-compensation scenario had no blob/reference transaction API.
- Green: raw-evidence plus MemoryHub/compilation/maintenance focused suite passed 35/35 and `npm run check` passed.
- Result: immutable content is stored once under `blobs/<sha256>`, each observation gets a separate payload-free provenance ref, legacy schema-v1 Markdown remains untouched, and episode catalog indexing occurs inside the same compensated raw-evidence commit.
- Different content cannot overwrite a blob; a failed catalog callback removes newly created reference/blob state instead of leaving a dangling half-commit.

## 2026-07-30 R7 bounded runtime status and default catalog cost
- Red: both status scenarios passed the parsed `{}` object into the old full-status callback; explicit `projection: detail` had no structural effect.
- Green: summary/detail, Skill catalog cost, Skills, capability, and Tool focused suite passed 60/60 and `npm run check` passed.
- Result: `runtime_status` defaults to a summary that does not load Session summary, Memory status, Guidance files, Team state, or full capability items; diagnostic detail requires the explicit enum field.
- The summary retains the exact final Tool names/digests. Model-facing Skill discovery keeps names/descriptions but removes diagnostic source IDs and absolute paths; the 20-Skill cost contract is at most 60% of the previous catalog while the diagnostic catalog remains unchanged.

## 2026-07-30 R8 Computer frontmost normalization
- Red: an active App with two windows produced two `frontmost=true` targets; an exact window-level false/true pair was flattened to true/true.
- Green: both normalization scenarios and the complete Computer suite passed 30/30; `npm run check` passed.
- Result: target discovery accepts only one exact window-level frontmost signal, leaves ambiguous active-App windows unknown, and marks inactive windows false. Background observation/action now requires an explicitly false focus state instead of treating unknown as safe.
- Scope: the repair stays inside Cua target normalization and ComputerManager focus checks; it adds no foreground action, approval, permission, dependency, or driver retry.

## 2026-07-30 resumed final verification
- The earlier handoff was premature because R6-R8 were still listed as remaining. Execution resumed without changing the acceptance criteria.
- R6, R7, and R8 are now implemented with generic red-to-green contracts. Full `npm test`, standalone build, and final `npm run ci` are pending on this complete source state.

## 2026-07-30 complete-source final verification
- `npm test` passed 754/754 with fail/skip/todo=0; standalone `npm run build` passed.
- The first complete-source CI run had one timing-only Cua lifecycle startup failure under coverage (753/754); the unchanged focused coverage scenario then passed, so no assertion or production timeout was changed.
- The clean CI rerun passed repository/release/dependency/asset checks, typecheck, 754/754 coverage tests with fail/skip/todo=0, 86.85% lines / 76.94% branches / 83.77% functions, build, and package smoke.
- No live Daemon restart/install, account access, real message, permission change, or GUI mutation was performed. All end-to-end-style verification used isolated temporary roots and fixture driver processes.
- Final task-owned commits through implementation: `12cf9f9`, `00375f6`, `b796cfa`, `696cb00`, `410f1a5`, `5eb2ead`, `b9c5ea6`, `67d0478`, `11e020a`, `5b90f85`, `9238dfe`, plus the final progress commit.

## 2026-07-30 release verification
- `npm test` passed 745/745 with skip/todo=0; standalone `npm run build` passed.
- First `npm run ci` stopped at dependency direction because Goal core imported the runtime failure contract.
- Moved the typed failure disposition to core with a runtime compatibility export; repository hygiene, release consistency, dependency direction, asset boundaries, typecheck, and the 10 affected focused tests now pass.
- Final CI rerun remains pending.

## 2026-07-30 final verification and handoff
- Final `npm run ci` passed: repository/release/dependency/asset checks, typecheck, 747/747 coverage tests with skip/todo=0, 86.70% lines / 76.95% branches / 83.68% functions, build, and package smoke.
- Standalone evidence also passed: focused R1 30/30, R2 31/31, R3 113/113, R4 29/29, capability contract 2/2, `npm test` 745/745, and `npm run build`.
- No Daemon install/restart or real account/message/UI mutation was performed. Temporary-root MimiAgent recovery tests exercised durable receipts and restart recovery locally; this is not presented as a live-provider eval.
- Remaining planned roots are Memory blob/provenance atomicity, bounded runtime status/context cost, and broader Computer focus semantics; R5 required no production change because current source already shares the final Tool array.
- Task-owned commits: `12cf9f9`, `00375f6`, `b796cfa`, `696cb00`, `410f1a5`, `5eb2ead`, `b9c5ea6`, plus this final documentation commit.
## 2026-07-30 多 Provider Review 修复

1. 目标：修复计划第十三节全部 8 项偏差，使结构化任务与精确 ModelTarget 贯穿 Session、Team、SubAgent、后台、视觉和生图。
2. 顺序：任务 0 基线与运行态；Media/视觉；路由一致性；Claude reasoning；Provider registry/control；上下文与预算；总门禁；安全部署与双 target canary。
3. 正确性边界：未知 Provider、模型能力、预算、凭据一律失败关闭，不猜模型 ID、价格或协议支持。
4. 副作用边界：保留 FIFO、权限、ExecutionLedger at-most-once、Task credential 最小化；started/uncertain 不重放。
5. 兼容边界：旧 Session、Team、Task IPC 可读；已开始 Run/Team 冻结旧 binding，下一 Run 才接受新 routeVersion。
6. 代码边界：只改任务书白名单；确需越界先记 BLOCKED 并跳过受影响部分。
7. 基线：HEAD=d01a6b7，工作树开工时干净；当前 detached HEAD，现有 `codex/multimodel-review-fixes` 指向同一提交。
8. 环境：本 worktree 缺少 node_modules，按任务书执行 npm ci；不得手改或提交生成 dist、package/lockfile。
9. 最大风险：缓存 Session actor 的 Resolver 漂移、legacy provider 污染 transport、媒体输入在 Adapter 转换时静默丢失。
10. 验收：每项红→绿；最终 tests>=755 且 fail/skipped/todo=0，全部指定门禁 exit 0，提交并推送任务分支。

### 任务 0 回执

- `npm ci` exit 0；仅因依赖缺失执行，prepare build 通过，package/lockfile 无跟踪改动。
- `npm test` exit 0：tests 755 / pass 755 / fail 0 / skipped 0 / todo 0。
- 真实 Daemon：build `0.12.0+8ef2c7b69eab`，PID 14088；active Event 0、Task 0、Outbox sending 0、host mutation 0。
- 第十三节精确列出 8 项偏差；真实 registry 能力边界继续按两个 DeepSeek V4 Pro target 和无 imageOutput 处理。
- 循环 1 开始：先为 Media 产品入口和 Anthropic/Gemini 图片 block 写失败回归。
- 循环 1 红测：聚焦 0/2；Anthropic 实际 content 为纯文本而非 image block，
  `model-workunits` 因 `createMediaTools` 不存在而模块加载失败；未发生 Provider 副作用。
- 循环 1 绿测：native/media/tool-policy 聚焦 19/19，`npm run check` exit 0。
  `generate_image` 直接进入 MediaRuntime，返回 kind=media 与 image-generation binding；
  agent-only registry 在 Provider 前 blocked，Anthropic/Gemini 保留 data URL 图片 block。
- 循环 2 开始：为跨两个缓存 actor 的 routeVersion 热刷新、跨 transport 历史与工具面写失败回归。
- 循环 2 红测：模型 Session/native 聚焦 4/6；缓存 actor B 路由更新后仍返回
  `left-answer`，`openai-responses` 历史仍保留 foreign provider id。
- 循环 2 绿测：模型/管线/策略聚焦 37/37，`npm run check` exit 0；两个缓存 actor
  下一 Run 同步 routeVersion=21，运行中 binding 不变；RunScope/status/history/Hosted
  Tools 按精确 providerId/transport，跨 Google transcript/tool-call 保持协议单元。
- 循环 3 开始：Claude high reasoning 的 manual/adaptive 显式能力与预算失败关闭。
- 循环 3 红测：Claude native 聚焦 1/3；adaptive 注册仍发 enabled+8192，
  manual 默认 max_tokens=4096/budget_tokens=8192 非法，未知 high 未能在 fetch 前拒绝。
- 循环 3 绿测：Claude/config/Gateway 聚焦 12/12，`npm run check` exit 0；
  manual 预算满足 1024<=budget<max，adaptive 发原生 effort=high，未知 high 在 fetch 前拒绝。
- 循环 4 开始：Provider registry add/set/list/test、热切换和 model_control 单一自然语言写入口。
- 循环 4 红测：commands 模块因 `runProviderRegistryCommand` 尚不存在直接失败，未写配置或发请求。
- 循环 4 绿测：commands/model-control/session/tool-policy 聚焦 40/40，`npm run check`
  exit 0；registry add/set/list/test 不保存 key、不重启，routeVersion 热更新；
  MimiAgent 自然语言写入口只暴露 model_control，legacy switch 工具仅保留兼容实现。
- 循环 5 开始：contextWindow、maxTurns、maxOutputTokens 冻结、预算校验与请求实际生效。
- 循环 5 红测：model config/router 聚焦 6/8；binding 三项预算均为 undefined，
  且 maxOutputTokens=4096/contextWindow=4096 未被配置 schema 拒绝。
- 循环 5 第二红测：model_control schema 1/2，route 的 maxTurns/maxOutputTokens 被 strict schema 拒绝。
- 循环 5 绿测：budget/model/worker 聚焦 31/31，`npm run check` exit 0；
  binding 冻结 contextWindow/maxTurns/maxOutputTokens，ContextManager、Provider maxTokens、
  Runner maxTurns 实际消费；非法输出预算在配置或 Provider 前失败关闭。
- 循环 6 开始：文档矛盾、CLI 帮助、自然语言入口和第十三节 8 项修正回执同步。
- 循环 6 绿测：README/ARCHITECTURE/CHANGELOG/.env.example/计划第十三节均已统一；
  产品工具面实际包含 model_control/generate_image 且不暴露 legacy switch 工具。
  白名单聚焦门禁 195/195，fail/skipped/todo=0，`npm run check` 与
  `git diff --check` exit 0。
- 循环 7 开始：运行完整门禁、覆盖率、密钥/生成物/无关 diff 复查。
- 循环 7 首轮全量：760/761；legacy runtime action recovery 因新工具面缺少
  switch_model 失败。按“旧命令只兼容 legacy”收敛为仅 legacy 配置暴露旧工具，
  registry runtime 继续只暴露 model_control；原失败与 Session 回归 12/12。
- 循环 8 第二轮全量：760/761；紧预算 Skill instruction 用例稳定复现，根因是新增
  基础指令超出原预算。压缩等价指令后原失败 1/1；第三轮全量 761/761，
  fail/skipped/todo=0。
- 循环 9 覆盖率：d01a6b7 临时 worktree 基线实测 755/755，
  line/branch/function=86.62/76.59/83.06；新增 registry fail-closed 分支回归后，
  当前 761/761、86.69/76.60/83.32，三项均不下降。
- 最终门禁：`npm run check:repo`、`npm run check`、`npm test`、`npm run build`、
  `npm run test:package`、`git diff --check` 全部 exit 0；白名单聚焦 195/195。
  密钥模式扫描 clean，无 package/lockfile、tracked dist 或越界文件 diff。
- 已切换到任务分支 `codex/multimodel-review-fixes`；下一步提交、推送，再按真实
  Daemon idle/备份/构建一致门禁决定部署和低成本 canary。
- 提交 `eaf0067` 已推送 `origin/codex/multimodel-review-fixes`。部署前连续确认
  active Event/Task/Outbox sending/host mutation 均为 0；官方备份及二次 verify 位于
  `/tmp/mimi-provider-review-rollout.OrXoo8/daemon-backup`，databaseIntegrity=ok。
- 全局包已安装并安全重启：旧 build `0.12.0+8ef2c7b69eab`、PID 14088；新 build
  `0.12.0+4698e88155a3`、PID 69823。重启后四类 activity 继续为 0。
- 两个已注册 target 的 registry health 均为 healthy。独立 Session 实际返回
  `FRIDAY_CANARY_OK`、`DEEPSEEK_CANARY_OK`；Trace 分别冻结 friday/deepseek 的
  `session-preference` binding，routeVersion=3，未串 target。
- Team canary 在同一 wave 冻结 `ds→deepseek/team.simple` 与
  `fr→friday/team.hard`，分别返回 `TEAM_DEEPSEEK_OK`、`TEAM_FRIDAY_OK`；
  临时 route 随后恢复 auto，当前 routeVersion=7，PID 未变。
- registry 没有 imageOutput；真实 `generate_image` 只调用一次并在 Provider 前返回
  `image-generation.default 没有满足 imageOutput/生图 的兼容模型`，未调用生图服务。
- Daemon doctor 的 ready=false 来自既有 dead-letter/digest、Connector readiness
  和 personal-daxiang checkout 路径告警；不属于本任务且未修改、重放或冒充通过。

## 2026-07-29 多 Provider、多模型分层路由

1. 目标：按最终规格实现同一 Daemon 内 Session、场景、SubAgent、TeamTask 与 Media WorkUnit 独立冻结模型。
2. 顺序：先恢复并复验 726 基线，再做 Gateway/Resolver，随后 Session 控制面、Team/SubAgent/后台/媒体，最后文档与总验收。
3. 初始安全边界：不提交、推送、部署或重启真实 Daemon；owner 后续明确授权真实部署、重启和 Provider 验收，started/uncertain 仍不重放。
4. 兼容边界：缺少新配置时合成 legacy target，旧 Session/Team JSON 继续可读，未知能力一律失败关闭。
5. 最大风险：保留既有脏改动；owner 后续明确要求解除斜杠阻塞，仅增量放开 `commands.ts` 及必需的 `daemon/chat-client.ts`、`daemon/service.ts` 命令链。
6. 环境差异：本地依赖未安装导致 `tsc` 不存在；detached HEAD 已核实为独立 worktree 预期状态，不做分支切换。
7. 任务 0：`npm run check` 通过；全量首跑 720/726，六项 Cua/QQ 环境争用聚焦复跑 40/40 通过，证据已写 BLOCKED。
8. 任务 1：Gateway/Resolver 缺失先红 0/3；route fallback reason 先红 0/1 后绿 1/1；配置原子性、四类 adapter、显式 client、capability fail-closed 均绿。
9. 任务 2/3：Session/Team/后台冻结均红→绿；斜杠命令先把 `current` 误作模型名红 0/1，随后 parser/IPC/runtime/schema 聚焦 166/166 绿且不重启。
10. 任务 4：文档已同步；最终 `752/752`、skip/todo 0，check:repo/check/build/test:package/diff-check 全绿；scope/secret 无未授权新增越界或真实凭据，多模型任务无 blocker。

## 2026-07-29 多模型真实 Daemon 验收

1. 重启前等待 Event/Task/Outbox/host mutation 全部归零；安装包与 Daemon 数据备份在 `/tmp/mimi-multimodel-live-20260729.xIc4QN`，数据库 integrity=ok。
2. 两个真实 OpenAI-compatible 端点的裸 API 分别返回 `FRIDAY_ROUTE_OK`、`DEEPSEEK_ROUTE_OK`；私有 `models.json` 仅引用 credential 环境变量名，权限 `0600`。
3. 首轮暴露 Conversation 带 cause 被误路由为 `background.default`：真实 Session B target=DeepSeek、实际 binding=Friday；新增策略红测 0/1 后按持久 Task kind 指定 scenario，绿 1/1。
4. 修复部署后并发 Session C/D 分别返回 `SESSION_C_FRIDAY_OK`、`SESSION_D_DEEPSEEK_OK`，binding 均为 `conversation.default/session-preference` 且 target 不串。
5. 运行中切换观察到第一 Run 保持 Friday，控制回执 `effective=next_run/daemonRestarted=false`，第二 Run 冻结 DeepSeek。
6. 同一 Team wave 的 simple/hard task 均 completed，分别冻结 DeepSeek/Friday；SubAgent researcher 独立命中 DeepSeek 并返回 `SUBAGENT_DEEPSEEK_OK`。
7. Friday 聊天成功但 Doctor 因可选 `/models/{id}` 返回 404 误报 unhealthy；adapter 红测 0/1 后改用通用 `/models`，两 Provider 的真实 `/models` 和 `/model doctor` 均 healthy。
8. 当前没有 imageOutput 注册，真实已安装 Media Runtime 在 Provider 调用前明确 blocked；未把视觉理解或普通 Agent 模型当作生图模型。
9. `/model route` 实机写入再恢复 auto，routeVersion 1→2→3，Daemon PID 始终 `81567`，证明普通路由修改不重启。
10. 最终运行构建 `0.12.0+bc01c6e46deb`；未提交、未推送，真实多模型验收无 blocker。

## 2026-07-28 M1 heartbeat blocked by runtime drift

1. `2026-07-28T12:22:34.171Z` heartbeat 观察到 Daemon 已从目标构建
   `0.12.0+9bf15be88f93` 变为 `0.12.0+316eb41416db`，并于
   `2026-07-28T12:07:07.169Z` 重新启动；因此 T0 建立的同构建连续 24h 窗口已中断。
2. 观察时还有 1 个 active Event（Task/Outbox/host mutation 均无活动），不满足
   idle 门禁。本轮没有执行只读 canary，没有重启、抢占、写动作、发送、前台激活
   或权限变更，也没有把 blocked 计为成功。
3. 工作区同时存在一组未提交的运行时开发改动，本 heartbeat 未修改或提交这些改动。
   只有这些改动形成可追溯提交、通过发布验证并部署为新的冻结构建后，才能重新建立
   M1 T0；原 run `ac47a076-956d-469d-b5b7-4a9036cf7947` 仍保留为历史成功证据，
   但不再满足最终构建连续 24h 的退出条件。
4. `2026-07-28T16:24:10.725Z` 再次观察时，Daemon 已于
   `2026-07-28T15:19:07.099Z` 重启为 `0.12.0+376bb1fbacc9`，且有 1 个 active
   Task worker。构建和 idle 门禁仍同时不满足，本轮继续只记录 blocked，没有执行
   canary 或干预该任务。
5. `2026-07-28T20:23:36.277Z` 观察时 Event/Task/Outbox/host mutation 已全部
   idle，但运行构建仍为 `0.12.0+376bb1fbacc9`，不等于 heartbeat 锁定构建
   `0.12.0+9bf15be88f93`。本轮因精确构建门禁失败继续 blocked，未执行 canary；
   idle 不能弥补构建连续性中断。
6. `2026-07-29T00:24:05.735Z` 观察时运行面继续 idle，Daemon 仍为
   `0.12.0+376bb1fbacc9`，没有新的冻结部署或 T0 证据。本轮继续因精确构建门禁
   blocked，未执行 canary，也未将旧 T0 或当前运行时计入 24h。
7. `2026-07-29T04:23:41.301Z` 观察到 Daemon 已于
   `2026-07-29T04:13:40.408Z` 再次重启为 `0.12.0+27e9a5182037`。运行面虽已
   idle，但工作区仍有未提交的 Daemon/Dispatcher 改动，既不匹配旧目标构建，也
   不能作为新的冻结基线；本轮继续 blocked，未执行 canary。
8. `2026-07-29T08:24:41.809Z` 观察到 Daemon 已于
   `2026-07-29T08:01:23.578Z` 重启为 `0.12.0+9ea51be56887`，并有 2 个 active
   Event；工作区还有大范围未提交运行时改动。精确构建和 idle 门禁均失败，本轮
   继续 blocked，未执行 canary、重启或抢占。
9. `2026-07-29T12:25:15.062Z` 已超过旧 T0 的名义 24h 终验时间，但期间构建
   连续性已中断。当前 Daemon 于 `2026-07-29T12:11:22.616Z` 重启为
   `0.12.0+d26fe770f81e`，有 1 个 active Event，且仍有未提交运行时改动；本轮
   继续 blocked，不能因日历时间到达而声明通过。
10. `2026-07-29T16:24:44.066Z` 观察到 Daemon 已于
    `2026-07-29T15:14:11.287Z` 重启为 `0.12.0+bc01c6e46deb`。运行面当前 idle，
    但工作区仍有大量未提交运行时和 M1 清单改动，且仓库基线相对上一轮监控发生
    重写；无法建立可追溯新 T0，本轮继续 blocked，未执行 canary。
11. `2026-07-29T20:26:16.029Z` 观察到 Daemon 已于
    `2026-07-29T17:33:12.981Z` 重启为 `0.12.0+4698e88155a3`。运行面 idle，
    但主工作区仍有大量未提交改动且落后远端 2 个多模型路由提交；该运行构建既不
    匹配旧目标，也不能证明来自远端冻结基线。本轮继续 blocked，未执行 canary。
12. `2026-07-30T00:28:13.145Z` 观察时 Daemon 仍为
    `0.12.0+4698e88155a3` 且运行面 idle，但主工作区仍有大量未提交改动并落后
    远端 3 个提交。没有新的部署、冻结基线或 T0 证据，本轮继续 blocked，未执行
    canary。
13. `2026-07-30T04:28:48.138Z` 观察到 Daemon 已于
    `2026-07-30T03:58:26.360Z` 重启为 `0.12.0+3fd675025b04`。运行面完全 idle，
    分支与远端已对齐，但仍有未提交的 Provider/个人消息运行时改动；该构建尚不是
    冻结发布基线，本轮继续 blocked，未执行 canary。

## 2026-07-28 M1 final runtime soak after owner-sensitive fix

1. owner 当前 Run 临时敏感值修复已合入并推送到完整集成分支
   `codex/mimiagent-integrated`，合并提交为 `3ed080e`。最终运行基线为
   `0.12.0+9bf15be88f93`；Daemon 已在无 active Event/Task/Outbox/host mutation
   的窗口安全重启，PID `27809`，运行 build 与当前产物一致。
2. Full Owner 状态已明确暴露 `ephemeralSensitiveModelAccess=true`。临时值仅允许
   “已认证直接 owner + Full Owner + 当前 Session/Run + 单次 15 分钟租约”进入
   Provider 输入；Safe、Workstation、外部 Event、SubAgent、Team、后台任务及其他
   Session 均不能继承。Session、Tool、Ledger、MCP、Connector、Trace、错误、流式
   输出和最终回答继续统一脱敏，不按业务关键词特判。
3. 最新构建首轮正式 canary run
   `ac47a076-956d-469d-b5b7-4a9036cf7947`
   (`2026-07-28T10:27:50.943Z`～`10:28:51.828Z`) 完成：
   20 requested/eligible/executed/success/qualifying，coverage=100%，eligible
   execution success=100%，blocked/failed/uncertain=0，S0/S1/S2/S3=0。
4. 分层结果为 Browser `5/5`、Computer `5/5`、Screen `5/5`、Shortcuts `5/5`；
   全部通过正式 ConnectorManager/ComputerManager 固定只读 probe，不含 direct
   worker、readiness 冒充、写动作、发送或前台激活。证据保存在
   `artifacts/m1-eval/canary-9bf15be88f93-t0.json`。
5. 最新构建的 24h 只读窗口从
   `2026-07-28T10:28:51.828Z`（北京时间 `2026-07-28 18:28:51`）起算，最早在
   `2026-07-29T10:28:51.828Z` 后终验。heartbeat `m1-24h` 已更新为每 4 小时在
   `/Users/liuyuran/Project/MimiAgent` 运行同构建正式 canary；忙时只记录 blocked，
   不抢占、不重启、不把 blocked 计为成功。
6. 发布级 `npm run ci` 已通过：674/674，skip/todo=0；coverage line 86.35%、
   branch 76.78%、function 82.77%，Build 与 package smoke 通过。升级前 Daemon
   备份位于 `/tmp/mimi-m1-rollout-20260728.vjfLI8/daemon-backup`，清单、摘要和
   SQLite integrity 已验证。历史 88 条已分类 dead letter 与未绑定
   `personal-daxiang` 保持为既有/外部问题，不误报为本次部署回归。

## 2026-07-28 process diagnosis permission Badcase

- 根因不是 SIP：Darwin `run_shell` 无条件进入 `sandbox-exec`，而 macOS 的
  `/bin/ps`、`/usr/bin/top` 带特权位，即使 profile 为 `allow default` 也会在 exec
  边界返回 `Operation not permitted`。
- 新增只读 `inspect_processes`：固定调用 `/bin/ps` argv，按 CPU/内存排序，最多返回
  50 条 PID、UID、RSS/VSZ、CPU/内存比例和 executable；不返回命令行参数，不支持
  signal、kill、注入、提权或 GUI 控制，也不需要 ActionIntent/逐次批准。
- Shell 保持一个简单边界：继续防止 Apple Events、Accessibility 和本机控制面绕过；
  同时启用 `pipefail`，管道中间失败不再表现为 `exitCode=0 + 空输出`。
- Agent 指令明确把 Shell `operation not permitted` 归因于 MimiAgent 自身沙箱，并优先
  使用已注册只读诊断能力；不得误报 SIP、反复换命令试探或直接把任务退回 owner。
- 修复已随构建 `0.12.0+b585e4b37ef5` 安装并安全重启 Daemon；真实 owner Run
  直接选择 `inspect_processes`，在 700 个进程中返回前 5 项并完成回答，没有尝试
  `ps`/`top`、误报 SIP 或要求 owner 手工执行。

## 2026-07-28 M1 current closeout

1. 正式实机门槛已达到：10 个 canary run 共 200 requested、129
   eligible/executed/success/qualifying、71 blocked、0 failed/uncertain，eligible
   execution success=100%，S0/S1/S2/S3=0。blocked 均未执行动作，保留在公开请求分母，
   不冒充成功。
2. 分层结果：Browser `36/36`、Computer `34/34`、Screen `28/28`、Shortcuts
   `31/31`，四个 App × 动作族 × 正式路径均为 100% eligible execution success。
3. Screen/Shortcuts 旧配置未迁移的根因是 live config 指向内容相同但路径不同的 managed
   script 副本；`673b59f` 以同名、普通文件、2MB 上限和 SHA-256 相等为门禁同步稳定
   action metadata，不改变 owner 的执行路径。
4. 无启动 status 的只读 Connector 不再陷入 readiness 自举死锁：只有已注册
   `effect=read` 动作真实成功后才建立 15 分钟 readiness 租约；显式 unavailable、
   write/unknown、route drift 和失败仍 fail closed。
5. M1 canary 的主机冲突门禁只判断 Event/Task/Outbox/host mutation；无关 Connector
   warning 不再误裁剪其他能力，目标能力仍由各自正式 Manager 独立校验。
6. CuaDriver 曾出现“进程和 socket 存在但客户端不响应”的假在线，后台精确重启后
   Accessibility/Screen Recording 均为 true，随后两轮各 `20/20` 全部成功。
7. 发布级 `npm run ci` 通过：646/646，skip/todo=0；coverage line 85.86%、
   branch 76.54%、function 83.06%，Build 与 package smoke 通过。为避免测试进程
   与真实 QQ 后台操作争用，CI 使用独立的 0700 临时锁目录；产品锁策略未改变。
8. 运行态为 `0.12.0+b585e4b37ef5`；Browser、Computer、Screen、Shortcuts 和其余
   已就绪本机通道保持正式门禁。`personal-daxiang` 因 owner target 未绑定诚实标记
   unavailable，不影响其他能力族验收。
9. 只读 24h soak 因运行时变化从新构建 run
   `587b8ad0-061c-40f3-b8c9-ed1d4dad8c18`
   (`2026-07-28T08:19:35.011Z`～`08:19:57.061Z`) 重新起算；本轮 6/6 实际动作
   成功且四类能力均有样本，14 项在并发忙门禁前 blocked。计划在
   `2026-07-29T08:19:57.061Z` 后验收。heartbeat `m1-24h` 每 4 小时只在运行态
   idle 时追加正式只读样本；忙时只记录 blocked，不抢占。
10. 本次部署前备份位于 `/tmp/mimi-process-fix-parent.p0Swnn/backup`，SQLite integrity、
    文件清单和摘要已校验；回滚仍必须在 Event/Task/Outbox/host mutation 全部 idle
    时执行。

## Previous checkpoint

1. 目标已落地：只有正式注册边界返回动作结果的 `live_action` 可计入 100 次；direct worker/readiness/blocked/uncertain 均不能晋级。
2. 证据 v2 已实现 `fixture|readiness|live_action|soak`、完整分母、分层报告、v1 明确迁移错误、原子并发/重复/uncertain 防重试。
3. 反向验证：证据测试先 0/9 红、后 9/9 绿；正式 probe 测试先 23/26 红、后 26/26 绿；最新聚焦 47/47。
4. fixture：60 requested，38 eligible/executed，24 success、22 blocked、11 failed、3 uncertain；qualifying live_action=0。
5. 正式 probe 已通过认证 Unix Socket、CapabilityResolver/Tool policy、ConnectorManager/ComputerManager；固定 read profile，拒绝 write/unknown/stale/漂移/控制面 App。
6. 最终 CI：640/640、skip/todo=0；coverage 85.59/76.54/82.98，高于给定基线 85.25/76.44/82.45（本机旧基线实测 85.24/76.43/82.42）。
7. 运行基线：Doctor ready、Connector 4/4 ready、Computer ready、unclassified=0；Daemon build `0.12.0+28a12e836691`，目标 build `0.12.0+4b45aa89825f`。
8. 安装门禁连续 3 轮均为 activeEvent=1、running=1；按 Goal 停止安装/重启/实机，不启用 Screen/Shortcuts，也不触发 TCC 或前台操作。
9. 本轮 canary 公开 20 requested、20 blocked、eligible/executed/success=0、coverage=0、qualifying=0、S0/S1=0；距 100 次仍差 100，95% 无可计算分母，24h soak 未开始。
10. 可复跑：运行态 idle 后先备份/校验，再安装目标 build，执行 `npm run eval:m1:canary -- --output <file> --build <build>`；旧 20 次仍按 0。

## 2026-07-28 Computer background ActionIntent Badcase

- 根因确认：M0 提交 `cd99619` 接入 ActionIntent 后，只给无 URL 的精确
  `launch_app` 声明 guarded 快速通道；正式 Ledger 下所有 Observation-bound
  click/type/scroll 即使 owner Run 已持有 `background` 能力也会在 Manager 前被拒绝。
- 修复最终收敛为轻量结构化授权：owner provenance、Run 的 background-or-higher
  grant、动作 background 三者同时成立即可进入快速通道；Observation 新鲜度、精确
  窗口、应用 route/allowlist 和前台保护由既有 ComputerManager 在执行时自动校验，
  不形成第二套模型授权条件，也不读取 Obsidian、按钮标题或自然语言关键词。
- 回归测试完整复现正式 `computer_observe → withExecutionLedger → computer_act`：
  修复前 0/1，错误为“缺少一次性授权”；修复后 Computer+Ledger 聚焦 55/55。
- 最终 `npm run ci` 通过：641/641，line 85.60%、branch 76.52%、
  function 83.01%，build 与 package smoke 均通过。
