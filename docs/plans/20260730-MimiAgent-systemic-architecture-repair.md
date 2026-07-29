# MimiAgent 系统性架构修复计划（2026-07-30）

## 目标与证据边界

本计划把 2026-07-29/30 deep live eval 的 50 个真实 Run 当作问题发现证据，把当前分支 `codex/mimi-systemic-architecture-repair` 的源码与测试当作实现基线。评测 B1–B3 运行构建、冻结评测 HEAD 和当前 `325af70` 加继承 working-tree 改动不是同一版本，禁止互相冒充。优先级固定为：真实任务完成与运行稳定 > 状态一致与可诊断 > 性能成本 > 功能覆盖。

量化总验收：

- 前四个根因必须至少完成前三个，且 R2/R3/R4 不得仍为 fail。
- 每个已修根因至少两种不同场景先红后绿；确定性错误最多一个 Daemon attempt，Goal 失败零半状态。
- canonical finalization 中 Session answer、journal digest、Execution receipt、Task result 引用同一 answer 和 Tool manifest。
- `npm run check`、focused tests、`npm test`、`npm run build`、`npm run ci` 实际通过，skip/todo 为 0；不降低覆盖率阈值。
- diff 不包含 prompt/关键词/Run ID/fixture 路径特判，不新增依赖、安全流程或跨不确定边界重放。

## 根因图

```text
R1 Daemon 无持久生命周期 epoch
 └─ 离线后无退出原因、监督决策和恢复关联

R2 失败缺 phase/disposition
 └─ 确定性错误被重试
     └─ R3 无 revision 的 Goal 多步写入
         └─ 半 Goal / 错误 resume / cancel 覆盖

ExecutionLedger 调用事实
 └─ R4 无 canonical finalization 投影
     ├─ Task effects / receipt 为空
     └─ final、Session、journal、Trace 多真相

R5 Capability/status/callable Tool 多真相
 ├─ R7 默认上下文和 status 无界投影
 └─ R8 Computer target focus 不是全局唯一投影

R6 Memory content blob 与 Run provenance 混址且提交顺序错误
```

## R1：Daemon 生命周期只有活进程瞬时真相

- 真实证据：S10（B1/PID 98385）到 S11（B2/PID 63052）之间、S24（B2）到 R04（B3/PID 85227）之间均发生评测者未触发的实例替换；X20 后 internal maintenance Run `df61…` 正常完成，随后三次 status 均 not-running、PID/socket 消失且日志没有 exit receipt，Y01–Y12 因此零提交。时间相邻不等于 maintenance 导致退出。
- 当前锚点：`src/daemon/service.ts` 的 launchd `SuccessfulExit=false`、signal/RPC shutdown 共用无原因的 AbortController、cleanup 错误被吞；status 仅由活进程构造；持久 schema 无 lifecycle epoch。
- 破坏不变量：每次 start/online/stopping/stopped/failed 必须有同一 epoch、build、pid、worker、supervisor、原因和前一 epoch 关联；离线也应能解释最后已知边界，但不得猜 crash 原因或重放 Task。
- 未知变体：外部 SIGTERM、未捕获异常、启动中失败、cleanup 失败、launchd 恢复、detached 无 supervisor、长 maintenance 后空闲退出。
- 测试缺口与红测：owner RPC shutdown 留下 `owner_shutdown`/exit 0；unexpected signal/throw 留下非成功终态且下一 epoch 关联它。另以长 maintenance 与 owner read 两种 workload 验证生命周期仍 online。
- 最小方案：新增权限为 0600 的原子 lifecycle snapshot/有界历史，启动先归档遗留 online 为 `unknown_ungraceful`；RPC shutdown 和 signal 分开记录；offline status/doctor读取最后 epoch。保留现有 no-replay 与 launchd 边界，不新增守护服务。

## R2：失败没有结构化 phase/disposition

- 真实证据：S22 同一 ownership rejection 重试五次；X03/X05/X09 三个不同 Goal 的确定性 setup 错误各重试到 dead-letter；X06 unsupported cancel 先做三次错误 overwrite；X20 pre-dispatch schema rejection 被误报 uncertain。
- 当前锚点：`src/daemon/dispatcher-retry-policy.ts` 依赖 error name、文本正则和 HTTP status；`src/runtime/mimi-agent.ts` 的 Goal ownership/order 抛 generic `Error`；Connector mapper 把非 failed-safe 异常兜底为 uncertain。
- 破坏不变量：只有明确 transient 且尚未 dispatch 的失败可自动重试；validation/policy/state/unsupported 一次终止；started/uncertain 终止且 no-replay。
- 未知变体：stale Goal revision、无 Goal cancel、Tool schema 缺字段、Provider 4xx/5xx、Connector timeout、MCP started 后断线。
- 测试缺口与红测：两种 domain state error 都 attempt=1、零写入；缺参数为 `pre_dispatch_validation` 且 execute=0，dispatch 后 timeout 为 uncertain 且不重试。
- 最小方案：引入小型 `RunFailureDisposition`（phase、kind、retryable、dispatched），typed domain error 优先；HTTP 仅作为 Provider transport fallback。移除自然语言错误分类，不改变明确 transient 的退避。

## R3：Goal 不是带 revision 的原子聚合

- 真实证据：X03、X05、X09 在不同 Session/目标都留下 active Goal 但无 pause/checkpoint/receipt；S22 把同一 Goal 当成其他 Goal；X04 resume 未执行 nextAction；X06 cancel 不支持且尝试覆盖。
- 当前锚点：`src/core/plan.ts` 的 `setGoal` 无 goalId/revision/CAS 并直接清 Plan，checkpoint 是第二次独立写；`src/runtime/plan-tools.ts` 把 setup 拆为多个 Tool；`src/runtime/mimi-agent.ts` 通过输入与 objective 是否完全相同猜 resume ownership。
- 破坏不变量：Goal mutation 必须绑定 immutable Session + goalId + expectedRevision；setup 全成或全不成；旧 Run 不得覆盖新 revision；cancel 为明确终态而非删除/改写。
- 未知变体：create+pause、create+Plan、不同措辞 resume、重启恢复、并发 stale Run、cancel、Team 与 Goal 同时更新。
- 测试缺口与红测：对两个不同目标在 setup 不同故障点注入失败，断言字节级旧状态不变；两种 continuation 措辞只依赖 goalId/revision，stale revision 一次失败零写入；cancel 两次幂等。
- 最小方案：Goal 增加稳定 id/revision（旧数据读取时兼容补齐），把 objective/contract/status/checkpoint/nextAction 一次原子提交；prepare 可先在 Run 内冻结 contract，再随 set 一次落盘；update/cancel 使用 expectedRevision。

## R4：Ledger 事实未投影为 canonical finalization

- 真实证据：S05/S06/S09 的文件 mutation 经独立验证但 Task `effects=[]`、journal `runtimeActions=[]`；X12/X19 两次 write/read/Shell 正确却无 receiptRefs；S21 的 Session/Goal 与最终 Completion 说法冲突；S07、S24、R06 的 final Tool/命令自述与 Trace 不符。
- 当前锚点：`src/runtime/tool-ledger.ts` 只为 side-effect 建账；`src/core/execution-ledger.ts` 已能列举 calls；completed receipt 不含 Tool manifest；`src/core/run-commit-journal.ts` 只保存 runtime controls；`src/daemon/dispatcher.ts` Task effects 只接 RuntimeEffect。
- 破坏不变量：一个 Run 只有一个 canonical answer digest、completion decision 和 bounded Tool manifest；Session、journal、Execution receipt、Task result、delivery、Trace 引用同一记录。
- 未知变体：file/Shell/MCP/Computer/Connector、failed-safe/uncertain/replay、blocked/continue Goal、恢复提交、投递抑制。
- 测试缺口与红测：`write→read` 与 `edit→hash` manifest 顺序/ref/status/target 一致；Shell exit 0 与 Connector uncertain 分别为 confirmed/no-replay；两种 non-pass Goal 的所有 final 表面 digest 相同。
- 最小方案：从现有 ExecutionLedger 生成有界脱敏 `ToolExecutionManifest`，不建第二本账；将它与 answer/gate/Goal revision 写入 canonical finalization，再由 Session、journal、Task 和 delivery 消费。旧 receipt/journal 缺 manifest 时按空数组兼容。

## R5：Capability、status 与实际 callable Tool 不是同一 Run 投影

- 真实证据：S10 status 声称 Shell off 但实际执行 `run_shell`；S17/S20 显示 Browser/Desktop ready 但 Safe Tool 集没有 `invoke_capability`；X16 fresh Workstation ack 后 canonical Run 实际为 Full Owner/91 Tools。
- 当前锚点：Capability items、profile display 和最终 Tool filtering 分阶段构造；`runtimeInfo()` 可读取 last snapshot；Daemon status 又只投影 digest。
- 破坏不变量：RunScope 冻结后，Security、permission、snapshot items、toolNames、digest 和 `runtime_status` 必须由同一对象生成。
- 未知变体：fresh/materialized Session、workspace actor 重建、Safe/Workstation/Full Owner、Connector readiness 变化、Mode 切换。
- 红测/方案：两种 wording 下同 profile 的 `runtime_status.toolNames` 等于实际 SDK Tool 名；fresh/materialized 切档均在下一 Run 生效。让 `RunCapabilitySnapshot` 成为唯一输入，status 不再重算。

## R6：Memory content blob 与 Run provenance 混址，且提交顺序相反

- 真实证据：X08 的内容在 X18 exact repeat 中正确生成但因不同 Run provenance 触发 content-address conflict；S11/S12 在明确 Session-only/零 Memory Tool 时仍自动写 episode，随后 R02/R04/R05 可消费保留状态。
- 当前锚点：`src/extensions/memory/raw-evidence-store.ts` 以内容 key 命名却在文件内嵌 Run-specific document；`src/extensions/memory/hub.ts` 先 catalog index 后 raw preserve；自动 episode retention 与显式 Memory Tool 不是同一控制面。
- 破坏不变量：相同内容只有不可变 blob；每个 Run provenance 是独立引用；blob+reference+catalog decision 原子收敛，失败不能留悬挂索引。
- 未知变体：跨 Session exact repeat、相同回答不同输入、并发 capture、重建 index、forget/suppression、旧 raw 文件迁移。
- 红测/方案：两个不同 Run 写相同 content 得到同 blob、两 provenance refs、零冲突；不同 content 不覆盖；catalog 写失败不留下 raw/catalog 半状态。采用 content blob + provenance reference，并在一个受锁提交顺序中完成；旧文件只读兼容、按需迁移。

## R7：默认上下文和 runtime status 没有面向问题的有界投影

- 真实证据：U02 简单 status 消耗约 95k input；X02/X16 只问五个 Tool 却展开完整状态；S24/R06 在 status 后超过 215k 总 token；新 Full Owner turn 固定输入约 36k。
- 当前锚点：General eagerly 披露 Tool/Skill/运行说明；`runtimeInfo()` 聚合 Session、guidance、Team、Memory 和完整 capability；status control 无 fields/projection。
- 破坏不变量：简单结构化状态查询不应装载与问题无关的正文，完整诊断必须显式请求。
- 红测/方案：两种五字段查询输出同一 bounded projection，序列化不超过 12 KiB；默认新 Run 静态上下文相对基线减少至少 40%，Tool 面不变。给 status 增加稳定 summary/detail projection，减少重复 disclosure，不做关键词路由。

## R8：Computer frontmost 是逐窗口复制值，不是全局一致状态

- 真实证据：S19 的 target/desktop 观察不一致；X14 一次 targets 返回四个同时 `frontmost=true` 的同应用窗口。
- 当前锚点：Computer target 枚举把 app active 状态复制给多个 window，缺少唯一 frontmost window 的全局归一化。
- 破坏不变量：一次 observation 至多一个可验证 frontmost target；无法确定时为 unknown/ambiguous，不能把多个窗口标 true。
- 红测/方案：单应用多窗口与两应用切换两场景最多一个 frontmost；信息不足返回明确 ambiguity。仅在 Computer target normalization 层修，不增加前台动作或权限。

## 实施阶段、迁移与止损

1. Phase A：R1 独立完成并提交；只写临时 data root 测试，不启动/停止真实 Daemon。
2. Phase B：R2 typed disposition，随后 R3 Goal aggregate；两者分别提交。R3 旧 Goal 缺 id/revision 时读取兼容并在首次成功 mutation 原子升级。
3. Phase C：R4 manifest + canonical finalization；旧 journal/receipt 以缺省空 manifest 兼容，不清理既有 Ledger，不改变 no-replay。
4. Phase D：依次 R5、R6、R7；R8 只有确认能在 target normalization 同层解决才纳入。
5. 每阶段先运行新测试确认红，再实现至绿；连续三次同因失败，回退该路线、写 `BLOCKED.md`，转入独立项。
6. 不触碰真实消息、账号、权限、生产数据；不全局 install/link/restart。最终只有在 Event/Task/Outbox/host mutation 全空且确有必要时才考虑隔离 E2E，本任务默认使用临时 Mimi home。

## 反作弊与最终审查

- 搜索新增 diff 中的自然语言关键词/正则路由、评测 Run ID、固定 prompt、fixture 绝对路径和 `NODE_ENV=test` 分支；任何命中必须删除或解释为协议/schema 校验。
- 每个根因单独 Conventional Commit；只 stage 本任务 hunks。继承 dirty 改动保留在 working tree，不纳入提交。
- 保存精简的红/绿命令输出、测试数、check/test/build/ci 结果和未跑 live 的原因到 `PROGRESS.md`；真实代码基线、运行 build、单测和 live receipt 分开陈述。
