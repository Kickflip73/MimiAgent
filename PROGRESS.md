# Progress

## 2026-08-01 M1 架构收敛 Goal
- 目标：按 `docs/plans/20260731-MimiAgent-M1架构收敛重构计划.md` 完成 ARC-000→503；正确性与副作用安全优先，不以代码完成冒充 M1 GO。
- 顺序：先冻结真实基线和现有脏改动，再按 executor/attention、capability/direct surfaces、pipeline/finalization、migration/deploy、live matrix/soak 的依赖链推进。
- 开工基线：HEAD `531850d`；热点文件 `3319/2376/2610` 行；`npm run check` 通过；非嵌套全量 `851/850`，fail=1、skip/todo=0。
- 唯一红测：`daemon-attention-v12` 的 owner route 夹具在 2026-07-24 写入、2026-08-01 隐式读取，越过 7 天有效期；需显式贯通模拟时钟并保留过期回退语义。
- 脏改动归属：PROGRESS 已记录的 Browser/Computer/Context 改动纳入 M1；`skills/agent-reach`、`skills/guizang-social-card-skill` 和无关资产只读保留。
- 最大风险：真实 `~/.mimi-agent` 迁移与 uncertain side effect 不得重放；个人渠道缺精确 owner target 时必须 NO-GO；最终 24h/72h/7d 日历窗口不可补算。
- ARC-000 红→绿：显式贯通 owner route/Briefing/Routine 的模拟时钟，并新增 7 天 + 1ms 回退断言；`npm run check` 与 `daemon-attention-v12` 6/6 全绿。
- 2026-08-02 真实运行基线：build `0.12.0+54d3940e1185`、Doctor ready=false；Task queued/dead-letter=`15/522`（37 未分类），Digest=5935，24h Runs=303，enabled/ready Connector=`8/4`。
- 真实数据已备份到 `/tmp/mimi-m1-arc000-20260802T1000Z` 并复验 `databaseIntegrity=ok`；schema=1、2542 files、116542139 bytes，未修改原 Task/Digest。
- ARC-000 clean-source CI：在提交 `d15645f` 的临时干净 worktree 原样运行 `npm run ci` exit 0；851/851、fail/skip/todo=0、coverage `87.41/77.46/84.06`，repo/check/build/package 全绿；临时 worktree 已删除。
- ARC-101/102 红测先行：executor 单一领取、非法 route、Briefing 修复和 v16 精确迁移首轮 37 项中 7 项按预期失败；实现后聚焦 44/44、`npm run check`、`npm test`、`npm run build` 全绿。调度已删除 `claimTaskTypes`，enqueue 统一拒绝非法 `type/executor/workspaceAccess`；v16 只修复 queued `briefing + session_actor + write`，未知历史 type/组合保留并计入 audit，fresh DB 直接创建 v16。
- ARC-102 真实备份演练：只在 `/tmp/mimi-v16-dryrun.PzWXYa` 副本执行 v15→v16；15 个 queued Briefing 全部原地转为 `isolated_worker + read`，未解释 Task 组合=0；5719 个 pending health Digest 按 Connector/状态保留 13 个、结束重复投影 5706 个，总 pending Digest `5935→229`。迁移后 integrity=ok、FK=0；自动迁移备份复读仍为 v15、15 个旧 Briefing、5935/5719 个 pending/health Digest，证明可回滚；真实 `~/.mimi-agent` 未修改。
- ARC-102 clean-source CI：提交 `816c8ab` 的干净 worktree 原样 `npm run ci` 通过；856/856、fail/skip/todo=0，coverage `87.53/77.47/84.15`，repo/check/build/package 全绿。首轮门禁发现并修正 migration→daemon 反向依赖及 4 个旧非法测试 route；唯一 route map 由 Store 以纯函数注入 migration，没有复制 allowlist。
- ARC-103 失败终态收敛：所有 Task failure 边界现在持久化稳定 `failure.code + RunFailureDisposition`；确定性失败直接 `failed`，transient 仅在重试耗尽后 `dead_letter`，uncertain 直接 `dead_letter`，自然语言 error 不再参与重试或运维分类。Task/activity 同步暴露结构化事实，历史 v16 记录只标记 `historical.* / legacy_failure`，不猜测旧文案根因。
- ARC-103 迁移保护：v15→v16 主迁移与已经提前升级的 v16 库都支持幂等回填；已有 v16 只在缺事实时先建 `task-failure-facts-v16-*` 备份，再事务写入并做 integrity/FK 校验与 audit。回滚注入证明完整性失败时 Task result 与 audit 都不提交；第二次打开不重复迁移或备份。
- ARC-103 真实 v16 副本演练：从当前 `~/.mimi-agent/daemon/mimi.db` 在线只读备份到 `/tmp/mimi-v16-failure-dryrun.GxsJHt`；548 条 historical dead letter 数量不变，结构化事实 `0→548`，activity 只报告 `legacy_failure=548` 且 unclassified=0。迁移后 schema=16、integrity=ok、FK=0、audit backfilled=548；自动备份复读为 548 条且结构化事实仍为 0；真实库复查仍为 0，未被演练修改。
- ARC-103 回归：`npm run check`、结构化 outcome/分类/v16 迁移与回滚聚焦 26/26、dispatcher/supervisor/worker 聚焦 13/13、`git diff --check` 均通过；完整 `npm test` 为 859/859，fail/skip/todo=0。提交 `caec5c4` 的干净 worktree 原样 `npm run ci` 通过：repo/release/dependency/asset、typecheck、859/859 coverage tests、build、package smoke 全绿，coverage `87.56/77.58/84.24`；临时 worktree 已删除。
- ARC-104 自治资源闭环：Run 来源只按 Task type 与不可变 Event source/trust 投影为 `owner_conversation/connector/health/briefing/maintenance/routine/eval/unknown`；近 24 小时 Run/Token、采样完整度和预算耗尽状态进入 activity、Doctor、health 与脱敏诊断。预算分母只含自治来源并计入 queued/running Run 预留；达到 Run 或 Token 的小时/日/单来源上限时，非紧急 Connector 进入 Digest、Routine/定时 Briefing 在 Event/Task 前延后，owner、手动 Briefing、urgent 和已 dispatch 收尾不被阻断。历史 Token 缺失按 `token_usage_unavailable` 失败关闭，同一来源从耗尽到恢复只各写一次 audit。
- ARC-104 真实副本验证：在 `/tmp/mimi-v16-failure-dryrun.GxsJHt/mimi.db` 用当前代码只读投影固定时点 2026-08-02 11:18Z；313 个 24h Run 全部归类为 owner=1、briefing=15、maintenance=12、routine=285，其余=0，unknown=0。全部历史 Token 明确为 sampling=unavailable、预算状态=0；integrity=ok、FK=0，真实 `~/.mimi-agent` 未修改。
- ARC-104 回归：红测先证明来源分类、Run/Token 限额、缺用量 fail-closed 和 Briefing 预算缺口；实现后核心 5/5、Attention/health/diagnostics/Host/resource 聚焦 33/33、`npm run check`、`git diff --check`、`npm run build` 全绿；完整 `npm test` 为 864/864，fail/skip/todo=0。
- ARC-104 clean-source CI：提交 `fa1c600` 的临时干净 worktree 原样运行 `npm run ci` exit 0；repo/release/dependency/asset、typecheck、864/864 coverage tests、build、package smoke 全绿，coverage `87.63/77.71/84.31`；临时 worktree 已删除。
- ARC-201 单一能力注册表：每个 Run 只创建一个不可变 `HostCapabilityRegistry`，重复工具名失败关闭；SDK 实际 `getAllTools()` 结果只解析一次并直接生成模型工具面与 Capability Snapshot。`ToolSetBuilder` 只保留 policy/mode 分类，Browser、Computer、文件/Shell、Memory、Goal/Plan 与个人消息为 direct，Skill/MCP/普通 Connector 为 deferred；旧 `inspect_mimi_capabilities`、`inspect_runtime_capabilities`、`invoke_runtime_capability` 不再进入新 Run 权限面。
- ARC-201 统一发现边界：模型侧只保留 `inspect_capabilities` / `invoke_capability` 两个 deferred gateway；Connector catalog 由 Host 直接调用 `ConnectorManager`，没有 Tool-to-Tool。发现缓存归 Run 内存所有，并只在可用性/readiness/action metadata 的语义 revision 变化时失效；探针时间戳不触发抖动。Browser/Desktop/personal Connector 只作为 direct Host 私有 backend，不会被 gateway 二次发现；个人消息模型面严格只有冻结 context/send 路由。
- ARC-201 反作弊与回归：新增 50 Host + 50 MCP + 50 Connector action 的首轮模型面测试，实际只暴露 2 个 gateway schema 且估算 ≤4000 tokens；Snapshot 与 SDK 实际工具集合逐项相等；相同发现连续 3 次只读 catalog 一次，revision 改变后 invoke 强制重发现。显式临时移除 Browser 私有过滤后边界测试按预期 `9/10` 红，恢复后 Registry/Connector/Run pipeline `33/33`；完整 `npm test` 为 `870/870`，fail/skip/todo=0，`npm run check`、`npm run build`、`git diff --check` 与 credential-like diff 扫描均通过。
- ARC-201 clean-source CI：提交 `cc184cb` 的临时干净 worktree 原样运行 `npm run ci` exit 0；repo/release/dependency/asset、typecheck、870/870 coverage tests、build、package smoke 全绿，coverage `87.69/77.79/84.18`；临时 worktree 及生成 `dist/` 已删除。

## 2026-07-31 Browser / Computer 原生可靠性 Goal
- 目标：主 Agent 直接、严格、可验证地使用 Browser 与 Computer，不再因两层能力发现、宽松 schema 或巨型观察结果陷入循环。
- 顺序：先修模型契约/权限/观察预算，再做 Host-owned Browser session 与 verify 闭环，最后补真实 E2E/soak 和文档。
- 基线：直接 Browser 1/1、直接 Cua Calculator 1/1；Mimi Browser 0/1（约 4 分钟 discovery loop），Mimi Computer 0/1（435,071 token）。
- 测试基线：相关 focused tests 52/52；真实 `test:computer:macos` 脚本不存在，现有 Browser/Computer 测试主要使用 mock/fake backend。
- 数据基线：Calculator 单次 Manager observation 70,837 bytes、212 AX elements，并重复携带 normalized elements 与 raw driver data。
- 继承改动：保留现有 PROGRESS/BLOCKED/蓝图修改；Browser Connector 的 logical label alias 属于可复用接缝，只修正相关缺陷并补回归。
- 架构边界：Browser 新能力留在 extensions/daemon/runtime 接缝；Computer 继续使用 Cua backend；Policy/Ledger/uncertain no-replay 不绕过。
- 最大风险：直接工具投影不能扩大来源权限；Browser session cleanup 不能把 uncertain close 误报为成功；Computer 裁剪不能丢失可操作元素。
- 开工 focused baseline：52/52，fail/skip/todo=0；Goal 执行期间每完成一项立即追加实际证据。
- 已落地一等 Browser 工具、Host-owned session、DOM-only 标准 snapshot、表单语义定位、wait/assert/close、16 KiB 结果预算和重复 discovery 熔断；Provider schema canary 中修复 URL format、record propertyNames 和 nullable locator 冲突。
- 首轮严格五类 canary 暴露 OpenCLI 1.8.6 的 `tab new` 会让原页脱离当前 session，以及 SDK nullable `page` 被重新写回 payload；没有用 prompt 掩盖。Connector 现以独立后台 OpenCLI session 实现稳定逻辑多标签，`list/select/close` 使用 Connector page ID，关闭后明确恢复 active page/URL；Host 同时剥离所有 null 占位。
- Browser backend 最终真实 soak：增强场景同时覆盖显式 `new_tab` 与真实 `target=_blank`、关闭新页后保留原页状态；`MIMI_E2E_ITERATIONS=30 npm run test:browser:macos` 为 30/30，成功率 100%，median 6602ms、p95 9000ms、p95 payload 892 bytes、session leak 0。
- 真实 Mimi 简单读取：4 个原生 Browser calls、33 秒，正确读取 `Mimi Browser Fixture` / `ready` 并 close；无 Skill、capability 或 Connector discovery。最终五类综合场景 `MIMI_E2E_ITERATIONS=10 npm run test:browser:agent:macos` 为 10/10，成功率 100%，median 108841ms、p95 146631ms、每轮固定 19 Browser calls + 1 Host context call、工具失败 0、非原生 fallback 0、leak 0。
- Computer observation 文本从基线 70837 bytes 收敛到实测约 1.5KB；degraded 且没有 AX/截图时返回 actionable=false，并在 Backend dispatch 前拒绝 UI 写。真实 Calculator/TextEdit 失败路径均约 8 秒停止，session leak/前台变化/光标变化/安全证据缺失均为 0。
- 真实 Mimi Calculator：3 calls（targets、background launch、window observe），观察 `actionable=false` 后停止，keypress/click/type=0；Daemon 状态从误报 ready 改为 `transportReady=true + operationalReadiness=degraded + ready=false`。
- 最终门禁：`npm test` 为 839/839，fail/skip/todo=`0/0/0`；`npm run check`、`npm run build`、`git diff --check` 均通过。测试数量较本 Goal 开工基线只增不减，真实 UI 脚本保持 opt-in。
- 已在无活动 Run/Tool/worker/Host mutation/Outbox sending 时安全重启用户 daemon 到 `0.12.0+035718607471`。部署后 `daemon probe browser-tabs` 返回 ready/fresh、itemCount=0；`daemon probe computer-window` 仍由外部 Cua AX 映射返回 `ax_window_unresolved`，并正确落为 `transportReady=true + operationalReadiness=degraded + ready=false`，未投递 UI 写。
- Computer 后续实测解除了上述外部阻塞判定：Finder 精确窗口 AX 可读；Calculator/TextEdit 新窗口在有界 settle 后可读，必要时一次 screenshot fallback 可恢复。根因是 Cua 列表中的离屏无标题伪窗口、新 AXWindow 短暂未就绪，以及同 bundle 多窗口时旧窗口抢占选择；均已在 Host 内解决。
- 参考当前 Codex Computer Use 的 app-centric state/action、AX-first 和截图回退，但 Mimi 没有照搬 Node REPL、MCP/Sky、diff 或多层结果状态。模型面只保留 `computer_observe({app,screenshot?})` 和 `computer_act({action})`；PID/window/Observation/dispatch/driver/admin 字段全部留在 Host。
- 真实 Driver/Manager Calculator + TextEdit soak：`MIMI_E2E_ITERATIONS=10 npm run test:computer:macos` 为 10/10，成功率 100%，median 48123ms、p95 64889ms、observation p95 6309 bytes，session leak/前台变化/Computer 动作导致的鼠标变化均为 0。
- 修复同 bundle 新窗口绑定并让 launch 直接返回 fresh state 后，真实 Mimi 组合 E2E 首轮为 1/1：Calculator 56 + TextEdit 读写完成，严格 8 个原生 Computer calls、112096ms、无额外 observe/非原生 fallback/session leak。修复前成功样本为 10 calls/176707ms。
- 真实 Mimi 组合 soak：`MIMI_E2E_ITERATIONS=10 npm run test:computer:agent:macos` 为 10/10，成功率 100%，median 102234ms、p95 107338ms；每轮固定 8 个 Computer calls，无额外 observe、非原生工具、工具失败或 session leak。每轮同时覆盖 app observe、Calculator 按键+结果观察和 TextEdit AX 读写。
- 模型 schema 不增加 foreground/dispatch：Host 后台优先；只在目标已置前，或 Driver 明确返回 `background_unsupported` 且本机 Full Owner Run 已有 foreground 权限时自动前台投递。回归证明 background-only authority 不升级且只投递一次。
- 关键 Calculator 真实 soak：`MIMI_E2E_ITERATIONS=30 MIMI_COMPUTER_SCENARIOS=calculator npm run test:computer:macos` 为 30/30，成功率 100%，median 32648ms、p95 34117ms、observation p95 6309 bytes；session leak、foreground change、Computer 因果鼠标变化和证据缺失均为 0。
- 最终门禁：`npm test` 为 846/846，fail/skip/todo=`0/0/0`；`npm run check`、`npm run build`、`npm run test:package`、`git diff --check` 均通过。`check:repo` 的 hygiene/release/dependency 三段通过，仅 asset-boundary 因继承的未分类用户 Skill `agent-reach`、`guizang-social-card-skill` 失败，本 Goal 未改动这些资产。
- Token 证据：5 个可回读的真实 Calculator + TextEdit Mimi Run 总 token 为 280045--374525，中位数 280743；相对开工时 435071-token 失败样本下降约 35.5%，但仍是明确的剩余成本。当前工具面只有两个，主要增量来自 8 次模型往返重复携带运行上下文；不为降调用数引入任意动作数组或可部分执行的第二套工作流。
- 部署前审计为 active Event/Tool/Task/Host mutation/Outbox sending=`0/0/0/0/0`，10 个 queued briefing 保持持久化未改动。非强制安全重启后用户 daemon 为 `0.12.0+6fbaa8baebe7`（PID 49691）；`browser-tabs` 与 `computer-window` 只读探针均为 ready/fresh/targetVerified/actionResult，Computer 状态为 `transportReady=true + operationalReadiness=ready`。

## 2026-07-30 Context Review 修复

### 任务 0 基线
- 继承上一轮未提交实现与无关脏改动，不重做、不提交、不部署；本节只追加记录。
- 原样执行 `npm run check` 与 9 个指定聚焦文件：check 通过，聚焦门禁进入全绿后才启动全量。
- 当前 Codex 外层为受限 workspace sandbox；首轮全量被 loopback/Unix socket `EPERM`、嵌套 `sandbox-exec` exit 71、测试夹具无法访问 `~/.mimi-agent` 系统性污染，命令 exit 1。
- 上述失败与 Context Review 无关，已写 BLOCKED；不修改范围外源码、测试阈值或既有断言，改用已批准的原始门禁在非嵌套沙箱环境复跑。
- Review 待复现数字：1,048,576 context / 962,068 input、30 轮 12K 结果累计降幅约 0、500K 在第 18 次前暂停、4317/telemetry-prod 丢失、授权 55 / 首轮 23。
- 非嵌套原始门禁复跑：`npm run check && npm test && npm run build` exit 0；814/814，fail/skip/todo=0，build 通过。
- 真实 1M 确定性复现：context=1,048,576、input budget=962,068；第 30 轮 raw/view=`91,759/91,760`、compression records=0；累计 `1,422,795→1,422,825`，降幅 0%，500K 会在第 18 次调用前暂停。
- 80% 复现：目标 `opaque-ABC_7788` 尚存，但旧事实 `OTLP 4317` 与 `telemetry-prod` 均丢失；确认不能继续依赖关键词快照。
- Review fixture 的完整授权面 55、首轮模型工具 23/schema 3,374；隐藏 web/Memory/Computer/MCP 无统一回读入口，留作任务 2 红测。

### 任务 1 三层 Context 修复
- 红：真实 1M/30×12K 复现累计 `1,422,795→1,422,825`（0%），第 18 次前撞 500K；80% 后 4317/telemetry-prod 丢失。
- 绿：工具结果按 callId+内容摘要登记独立 Artifact；首次消费后每轮变有界语义摘要+`context-artifact:*`，同 Session/Run 可校验回读，越权失败。
- 70% 工作快照独立持久化，含关键事实；80% 才替换旧对话，最近 3 个 user 回合原文保留；无法覆盖事实时明确失败。
- 当前确定性 1M 复算：round30 raw/view=`92,209/7,126`，最大请求 7,126；累计 `1,429,770→153,500`，下降 89.26%，未撞 500K，三项关键事实均在。
- 红→绿聚焦：Context 先因工具协议 ID 误入快照及末项未有界失败，修复后 9/9；canonical Session 深比较不变、协议无孤儿。

### 任务 2 真正渐进披露
- 新增统一 `inspect_runtime_capabilities`/`invoke_runtime_capability`，覆盖 builtin、MCP、Computer、Memory、Goal、Skill、Connector。
- 入口只索引 Host/Mode/Security/Policy 已授权并已包装 Ledger 的精确工具；未知/未授权返回失败，隐藏不撤权也不升级权限。
- Skill availability 改用完整 Host 授权面，首轮可见面仍有界；Core fixture 的首轮 schema≤4K 继续通过，Connector disabled action 描述为 0。
- 红→绿：初版未知能力测试误按 SDK throw 契约；核实 SDK 返回失败 Tool result 后改测公开契约，7 类授权能力发现/调用与未授权失败均通过。

### 任务 3 Memory 与统计补齐
- Embedding 不再平均为单文档向量：约 400-token/80 overlap 的每个 chunk 独立入 SQLite，cosine 阈值后按页面聚合；旧单向量表写入为 0。
- MMR 现在迭代计算 query relevance 与候选 diversity，并硬抑制近重复；自动召回≤3条/900 tokens，无关查询为 0。
- fake embedding 语义改写命中；数据库已有 chunk 向量但当前 Runtime 无 embedding client 时仍报告 lexical-only。
- 短“继续”只补 Goal 与最近两轮 user/assistant 对话，跳过 function call/result；Manifest 每次模型调用重建，Raw Session 不含 instructions/tools，reserve 只显示预留，压缩次数按 Run 累计。
- 扩大聚焦门禁：92/92；随后 Core/Memory/Pipeline/RunContext 50/50，fail/skip/todo=0。

### 待最终门禁
- 待执行原始 `npm run check && npm test && npm run build`；若外层沙箱再次污染，使用已批准的非嵌套原始命令复跑并保留两份证据。

### 最终门禁
- 非嵌套原始命令 `npm run check && npm test && npm run build` exit 0。
- 全量 `818/818`，fail/skip/todo=`0/0/0`；较基线 814 新增 4 条真实回归，TypeScript check/build 均通过。
- 反向验证：1M 长跑 `0%→89.26%`；4317/telemetry-prod 丢失→保留；隐藏 7 类能力不可达→统一精确发现/调用；单文档平均向量→多 chunk 独立向量+页面聚合。
- canonical Session、function call/result 配对、Policy/Ledger 与 uncertain no-replay 的既有全量测试均绿。
- 本轮未提交、部署、重启、安装全局包、修改真实 `.mimi-agent` 或运行 live embedding canary。

### 独立 Review S1 根因续修
- 红：真实 1M/962,068 input 下，108 条长日志/代码在 raw=675,770（70.24%）因单句 >2K 固定上限中断；140 条独立事实在 80% 因 128 条快照上限中断。
- 红：fake MCPServer 50 tools 时 Manifest 仅 1 tool/~11 schema tokens，但最终 SDK `getAllTools()` 为 51 tools/~13,618 schema tokens；原生 `mcpServers` 绕过渐进披露。
- 修复：70% 只调用无工具 semantic summarizer seam 准备带 `coveredItems/sourceDigest` 的持久快照，失败可复用已验证旧快照或保留仍可装入的原视图；80% 才替换已覆盖前缀，最近三轮/canonical/protocol 不改。
- 修复：Host 先将 MCP Tool 以 server-prefixed 精确名、strict 参数 schema 和 MCP ExecutionLedger 物化到统一 catalog；最终 Agent 不再接收 `mcpServers`，首轮只有 discovery/invoke gateway。
- 修复：Context Artifact 不再改写旧 ref 的 runId；跨新 Run 重新登记会生成携带 `originRunId` 的当前 Run alias，旧 ref 归属保持不变。
- 红→绿：新增真实 1M 长日志、140 facts、真实 fake MCPServer、最终 `agent.getAllTools()`、schema 与 Ledger once 回归；首次 MCP 红在 SDK 非 strict schema 改写，Host strict 物化后 focused 66/66 与核心 focused 28/28 全绿。
- 量化复算：1M/962,068 input 下长日志 raw=675,400（70.20%），140 facts+长结果 raw=780,238（81.10%），两项均通过 semantic seam；30×12K 为 `1,429,770→57,280`，下降 95.99%，最大请求 3,472、round30 `92,209→3,472`，4317/telemetry-prod/opaque ID 保留。
- MCP 复算：Host catalog 50 项，但最终 `agent.getAllTools()` 只有 2 个 gateway/schema 270 tokens，`mcp_fake__*` 隐性 schema=0；精确发现后调用两次只执行/授权一次。
- 完整门禁首轮在外层 workspace sandbox 为 808/820：11 项来自测试 Runner `{}` 不含真实 `runContext.usage`，修复双桩兼容；另 1 项为嵌套 `sandbox-exec` exit 71，同文件非嵌套复跑 7/7。
- 最终非嵌套原始 `npm run check && npm test && npm run build` exit 0：820/820，fail/skip/todo=0，TypeScript check/build 通过；较独立基线 818 新增 2 条反作弊回归。
- 未运行 live Provider、Daemon、`eval:agent`、部署、重启或真实用户数据读写；live summarizer canary 按任务边界保留在 BLOCKED。

## 2026-07-30 上下文系统任务
1. 目标：canonical Session 保持全文，模型每次只接收此刻有用、协议完整、可恢复的派生 Context View。
2. 顺序：统一 Context View → 能力渐进披露 → 相关记忆召回 → TUI 统计与长跑保护 → 总验收。
3. 正确性边界：80% 才语义压缩，最近 3 个用户回合逐字保留，不用字符裁剪冒充摘要。
4. 安全边界：权限与 Host/Policy 不变，canonical Session 不回写，uncertain 副作用绝不重放。
5. 成本边界：首请求 schema≤4K、Connector≤1K、自动记忆≤3条/900 tokens，长跑估算降幅≥70%。
6. 实现边界：无 Router LLM、关键词工具路由、常驻服务、新依赖、全量预载或真实用户数据修改。
7. 基线首次因缺少本地 `tsc` exit 127；已写 BLOCKED，仅 `npm ci` 恢复 lockfile 依赖且 prepare 通过。
8. 复跑 `npm run check` exit 0；指定 6 个文件共 54/54，fail/skip/todo=0，与任务书记录一致。
9. 工作树继承 16 个用户改动文件；本任务与 `src/runtime/mimi-agent.ts`、`CHANGELOG.md` 重叠时逐块保留。
10. 最大风险：SDK 过滤视图持久化污染、工具协议孤儿、隐藏 schema 被误当授权、统计把 reserve 当 usage。

### 任务 1 统一 Context View
- 红测 1：`findLastIndex` 不受 ES2022 lib 支持，`npm run check` 失败；改为反向索引循环后通过。
- 红测 2：30 个大工具结果虽配对但工作快照误收整段 JSON，模型视图 23,315 tokens；改为工具结果只抽稳定引用，收敛到 8K 内。
- 绿测：`npm run check` 与 Context/Session/Core 聚焦 76/76，fail/skip/todo=0。
- 行为：70% 生成结构化工作快照，79% 不压缩，80% 才替换较早历史；最近 3 个用户回合原文保留。
- 每次模型请求通过 SDK `callModelInputFilter` 重算；大结果变语义事实+sha256 稳定引用，调用/结果配对保留。
- canonical Session 回归逐项深比较不变；派生摘要明确禁止用于副作用重放。

### 任务 2 能力渐进披露
- 红测：初始 Capability Snapshot 仍展开 Connector operation/action；旧管线测试要求 action 名进入首轮摘要。
- 绿测：`npm run check` 与 Core/Connector/Pipeline/Policy/Host 聚焦 119/119，fail/skip/todo=0。
- 普通 owner 首请求只保留通用核心、Skill 三入口及 Connector inspect/invoke；实测 schema 估算≤4K。
- 17 个 Connector 合成摘要≤1K，仅含 id/availability/readiness/coverage/capability group/actionCount。
- 禁用 Connector 的 action 描述为 0；action 名和 usage 只在精确 inspect 结果中披露，invoke 仍走 Host/Policy/Ledger。
- Skill 首轮只放 name/description/location，SKILL.md 与引用仍由 use_skill/read_skill_resource 按需读取。
- 选择与 owner 文本无关；结构化 Run policy/Mode/Security 仍是授权和额外工具面的唯一来源。

### 任务 3 相关记忆召回
- 红测：自动 State Loader 每轮并发加载 hotProfile，查询还拼入 source/actor/conversation 恒定噪声。
- 绿测：`npm run check` 与 Memory/RunContext/Pipeline 聚焦 41/41，fail/skip/todo=0。
- hotProfile 路径不再执行；稳定行为继续由 PREFERENCES.md 注入，自动 recall 最多 3 条/900 tokens。
- 普通 query 只用当前用户意图；仅“继续/接着”等短续接补 active Goal 与最近两轮摘要。
- FTS5/BM25 保留；embedding 文档按约 400-token chunk/80 overlap 求均值，cosine<0.62 不命中。
- episode 单独做 90 天时间衰减；MMR 以 0.72 相似度去重，近重复合成结果最多一条。
- fake embedding 语义改写命中、两个无关 query 返回 0；状态明确显示 hybrid 或 lexical-only。
- 当前机器无独立 embedding live canary，本任务只验证确定性 fake；不得冒充真实 semantic 实测。

### 任务 4 统计与长跑保护
- 红测：累计输入保护首次回归期望文案与实际结构化错误不一致（51/52）；按真实错误契约收紧断言，未改判断阈值。
- 红测补充：为保证“每次请求有界”新增硬失败后，80% 极小合成样本因快照开销超过 202 tokens 红；补入可压缩旧背景以验证真实语义替换，未放宽 80% 或预算断言。
- 绿测：`npm run check` 与 Config/ContextView/Host/Pipeline 聚焦 53/53，fail/skip/todo=0；语义视图仍超预算时明确失败且 canonical Session 不变。
- TUI snapshot 已按请求的 Session actor 读取；`/context` 分列 Last request actual、Run cumulative、模型视图占比、Raw Session、静态工具/能力开销、压缩次数。
- protocol reserve 仍单独显示“仅预留”，不再计入 request/session 已用 token。
- 默认上限为 32 次模型调用或 500K 累计输入估算；先触限时写 interrupted checkpoint 并暂停，不删协议单元，不回滚/重放 uncertain 动作。
- 30 轮、每轮新增 12K 工具结果的固定合成长跑：旧算法累计 1,429,410 tokens，派生视图累计 53,837，降幅 96.23%（门槛 70%）。
- 文档已同步 canonical/派生视图、70/80 阈值、渐进披露、相关记忆、统计与长跑保护；待最终全量验收。

### 最终验收
- 完整套件首次只有范围外 Cua 生命周期时序失败；原文件立即复跑 31/31，未修改 Computer 源码或断言。
- 下一次完整终态暴露 6 个真实回归：渐进披露隐藏了既有 Session/模型切换及完成控制工具；修复后恢复/schema/管线聚焦 92/92。
- 最终原样执行 `npm run check && npm test && npm run build`：exit 0；814/814，fail/skip/todo=0；TypeScript build 通过。
- 反向验证链：Context View 大结果 23,315→≤8K；continuity 预算红→10/10；控制工具缺失 6 红→92/92；全量 808/814→814/814。
- 合成长跑独立复算仍为 1,429,410→53,837 tokens，累计估算下降 96.23%；canonical Session、Policy/Ledger 与 uncertain no-replay 测试均绿。
- 交付仅含源码、测试、ARCHITECTURE/CHANGELOG、PROGRESS/BLOCKED；未部署、重启、安装全局包或修改真实 `.mimi-agent` 数据。

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
14. `2026-07-30T12:29:48.205Z` 观察到 Daemon 已于
    `2026-07-30T10:05:34.158Z` 重启为 `0.12.0+4c739a2ce947`。运行面完全 idle，
    但本地分支领先远端 1 个未推送运行时提交，Browser Connector 仍有未提交改动；
    该构建不可视为冻结基线，本轮继续 blocked，未执行 canary。
15. `2026-07-30T20:30:11.911Z` 观察时 Daemon 仍为
    `0.12.0+4c739a2ce947` 且运行面 idle，但本地仍领先远端 1 个提交，上一轮文档
    与 Browser Connector 改动均未收敛；同时 Digest backlog 升至 1051、
    `personal-daxiang` 离线、Browser readiness stale。本轮继续 blocked，未执行
    canary；较早的 `16:29Z` heartbeat 被本次更新检查覆盖，不重复计数。

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

## 2026-08-02 ARC-202～205 Phase 3 实测

1. ARC-202 Browser 确认复用唯一 Host-owned Browser Manager：确定性回归 13/13；
   当前构建正式 macOS E2E 1/1（7657ms，最大 payload 892 bytes，session leak=0）。
2. ARC-203 先以 8 次瞬态 AX 缺失复现旧 5-attempt settle 红测，再以 20-attempt
   settle、首轮 40 elements、最多 12 screenshots 修复；提交 `59ae6b4`。Cua Driver
   `0.16.0` 的一次 Calculator 正式运行 1/1，但升级后的 Screen Recording=false，
   重复 Calculator/TextEdit/Finder 均 0 AXWindow fail closed，故为
   `implemented_blocked`，不以孤立成功冒充 readiness。
3. ARC-204 Shortcuts catalog 改为稳定 `{id,name}`，执行只接受最新签发 id；提交
   `1c38f3d`，配置/退役/Shortcuts 回归 9/9。installed Daemon 的正式只读 probe
   receipt=`ce7e541b-ea1d-47b7-8d13-5b7643a4d776`，ready/fresh/targetVerified/
   actionResult=true、itemCount=0；Screen 仍受同一 TCC 阻塞，未执行写动作。
4. ARC-205 QQ 正式 `PersonalMessageHub → ComputerManager/CUA` 路径先因模块不存在
   0/1 红、后 QQ 5/5 绿；与 Hub/Connector/Run pipeline/Computer 合并回归 87/87，
   `npm run check && npm run build` 通过，提交 `faaf848`。真实 Manager read 因当前
   AX/TCC fail closed，未 action；没有 Shell、AppleScript 或前台按键降级。
5. 大象仍缺稳定 owner target；微信 bridge=`bridge_unavailable` 且无稳定 snapshot/
   message-id Adapter；QQ 仍缺 inbound observer。三条通道均未发送、未猜目标、未把
   私聊内容写入证据。最终全量 `npm test` 为 876/876，fail/skip/todo=0；Phase 3 以
   `implemented_blocked` 退出，继续 ARC-301～303。

## 2026-08-02 ARC-301～302 Run Pipeline 与普通 Run 终态

1. ARC-301 已把普通 Run 的 Scope、State、Capability、Context、ToolSet、Request、
   Fact collection 与 Commit decision 固化为可独立测试的阶段；模型可见只读 Tool
   facts 与 side-effect Ledger facts 在 Host 汇合，读操作不会因此进入重放账本。
2. ARC-302 新增 `completed / partial / blocked / interrupted / failed / uncertain`
   六类结构化 outcome；判定只消费 SDK、Tool、Ledger 与 Gate 事实，不解析模型答案
   关键词。Plan 降为 UI 进度，Goal/Completion Contract 保留强完成语义；非完成答案
   由 Host 约束并绑定 SHA-256、manifest、原因、下一步和 evidence refs。
3. 反向测试先分别以缺少 outcome classifier、fact collector 和 failure Finalization
   传播接口得到红测；实现后 Run finalization/fact collector 为 5/5、21/21，真实
   Provider disconnect 集成为 9/9，Dispatcher Task/Outbox 一致性为 4/4。
4. 同一份规范 Finalization 已贯穿 Error、Session、Task、Trace、Run Commit Journal
   与 Outbox；Journal 对同一 execution key 选择最新 attempt，并 finalize 所有旧 attempt，
   不重放 uncertain Tool。旧持久化记录读取时补齐兼容默认值。
5. 提交 `6a96147` 落地实现，提交 `04df91e` 锁定矩阵与架构契约。最终聚焦验收
   34/34、`npm run check`、`npm run build` 通过；全量 `npm test` 为 883/883，
   fail/skip/todo=0。继续 ARC-303 热点文件与生产 LOC 收敛。

## 2026-08-02 ARC-303 组合根第一段

1. 先加行数门禁得到 `mimi-agent.ts:3424 > 1800` 红证据；当前三个组合根已收敛为
   `1627 / 1795 / 1900`，`tests/architecture-budget.test.ts` 通过。
2. `RunPipeline` 现独占 prepare/execute/异常回收，`RunCommitCoordinator` 独占
   complete/fail/receipt recovery；`AgentRunService` 删除第二个 commit facade。
3. Daemon 初始化、chat snapshot、launchd 配置和生命周期退出 `service.ts`；Activity、
   Outbox、Schedule、Run、Memory observation 按现有表级不变量退出 `store.ts`，
   `MimiStore` 保留跨表 transaction 与 schema migration facade。
4. 全量原始门禁 `npm run check && npm test && npm run build && git diff --check`
   exit 0，skip/todo=0；额外聚焦 Runtime 99/99、Store/Memory 23/23。
5. ARC-303 尚未关闭：以 `e1dd9a0` 开工口径计，相关生产文件基线约 9450 行，
   当前含新模块 10128 行（净 +678）；距离硬目标 8505 仍差 1623 行。此提交只保存
   已验证的职责所有权与热点门禁，不把纯搬文件冒充净 LOC 达标。

## 2026-08-02 ARC-303 第二段与 ARC-401 副本验证

1. Owner 权限已在配置读取边界一次折叠为固定 `permissionMode`；删除 Session/Chat
   动态 SecurityProfile 切换、三套 Tool 重建和 RunScope profile 组合维度。首轮 Context
   也不再预跑第二套 semantic/artifact view，SDK 每轮统一走一个有界 input filter。
2. Task claim/control 与 v13～v16 迁移备份判定共用单一事务路径；Daemon management RPC
   使用一个 operation table；Connector action metadata 只由一个同步函数更新。相关 Runtime
   101/101、Store/Dispatcher/Migration 26/26、Context/Skill 46/46 聚焦回归全绿。
3. ARC-303 第三轮完整门禁仍红：热点为 `1507/1664/1602`，全部显式生产面
   `9471 > 8505`，还差 966 行；未改阈值、漏计文件、压缩格式或删除受测能力。全量
   887 项首轮为 885/887：LOC 红线及一个因删重复 Context 预计算暴露的 Skill manifest
   回归；后者已用无第二套模型视图的轻量初始 manifest 修复。排除架构预算文件后再次
   顺序执行全部功能回归为 885/885，fail/skip/todo=0；架构预算复跑为 1/2，唯一红项
   仍是同一个生产 LOC 断言 `9471 > 8505`。
4. ARC-401 新增反向门禁：SQLite `user_version=17` 在 WAL PRAGMA 前拒绝，数据库字节
   与目录项不变；`models.json version=2` 抛明确 `UnsupportedStateVersionError`，不隔离、
   不覆盖。迁移/配置测试 22/22，`npm run check/build/test:package` 全绿；独立 JSON 边界已
   提交为 `4f6112d`，SQLite 边界因与 ARC-303 的 `store.ts` 重构同文件交织，未混合提交。
5. 真实备份 `/tmp/mimi-m1-arc000-20260802T1000Z` 只复制到
   `/tmp/mimi-arc401.QZemLu` 演练：v15→v16 后 Task 1626 不变，旧 queued Briefing
   `15→0`、最终 route `0→15`，pending Digest `5935→229`；audit 记录 health
   `5719→13`、collapsed=5706、unresolved=0，integrity=ok、FK=0。
6. 自动生成的 rollback backup 复读仍为 v15、Task=1626、旧 Briefing=15、Digest=5935、
   integrity=ok、FK=0；全新库直接生成 v16/15 tables、integrity=ok、FK=0。真实库与
   `models.json` 前后 SHA-256 分别保持 `2bdaf657…`、`c1812853…`，未迁移或重启真实 Daemon。
7. ARC-402 前只读复核当前已安装 Daemon：运行面 idle（active Event/Task/Tool/Host mutation
   与待投递 Outbox 均为 0），但 build 仍为 `0.12.0+54d3940e1185`，不是本轮源码；Doctor
   `ready=false`，Cua Driver 0.16.0 的 Accessibility=true、Screen Recording=false，
   `personal-daxiang` unavailable，另有 dead letter=549、Digest=6410。未把旧构建 idle
   冒充新构建 readiness，也未越过 ARC-303 红线执行安装、重启或建立 T0。

## 2026-08-03 ARC-303 第四段：启动能力边界与重复运行态

1. 先在 `run-pipeline` 加反向断言，证明 `permissionMode` 仍被复制进每轮 RunScope，红测
   为 20/21、`true !== false`；现已改为启动时一次生成固定 `RuntimeAccess`，Capability、
   ToolSet、MCP、Computer、Team worker 与临时敏感输入只消费实际能力，不再携带或动态
   切换 Safe/Workstation/Full Owner profile。
2. 删除 Session/Chat 的重复 Security profile、首轮重复 Context view、`lastContextStats`、
   `lastContextTokens`、`lastContextUsage` 和累计 compression 状态；最近请求只以
   `ContextManifest` 为权威，持久历史仍独立计算 raw/archive 统计。Task 安全点控制与租约
   恢复共用一个事务终态函数，Codex checkpoint 复用同一租约校验。
3. 相关回归依次为 Runtime 123/123、Chat/Commands 161/161、Context 117/117、Task 16/16，
   `npm run check` 全绿；排除唯一架构红线的全量 coverage 实跑 885/885，skip/todo=0，
   总覆盖 line=88.11%、branch=78.11%、function=84.52%。
4. 显式生产面从 `9471` 降至 `9317`，热点 `mimi-agent/service/store = 1466/1660/1567`，
   三个单文件预算均绿；总量仍为 `9317 > 8505`、尚差 812，故 ARC-303 与依赖它的
   ARC-402 继续保持红线，未部署、未建立 T0。
5. 操作审计：曾对只读零命中搜索执行一次 `rg ... || true`；没有运行测试、构建或写操作，
   也没有掩盖非零验收结果，但违反 Goal 的命令形态约束，已如实记录且后续未再使用。

## 2026-08-03 ARC-303 第五段：唯一组件端口与完整 LOC 退出

1. `RuntimeComponents` 现同时是 Soul/Preferences/Memory/Skills/MCP/Computer、模型 registry
   与 state ports 的唯一 owner；删除 `MimiAgent` 对 Plan/Team/Ledger/Trace/Session/Model 的
   getter 和可变镜像。RunPipeline、RunCommitCoordinator、控制面直接读取同一组件端口，
   并删除两套平行 Host/Port interface 与三个 `as unknown` 强转。
2. 强转移除后，聚焦回归真实暴露旧 Pipeline 仍读取已删除 `host.ledger`；现已统一改读
   `components.state.executionLedger.store`。已取得 SDK stream 后的 Provider 断线也由
   RunService 明确传为 interrupted，Error/Session/Journal/Trace 继续引用同一 Finalization。
3. `projectRunStreamEvent` 成为 Terminal、Daemon live event 和 RunService 的唯一流事件投影；
   Event kind/trust 由共享 Zod schema 解析，Provider credential 环境变量名复用同一函数；
   Activity/Outbox/Run 读取投影和 SQLite table owner 不再由组合根复制。
4. 防漏计审计先得到表面绿 `8497/8505`，随后发现新 `stream-projection.ts` 82 行和
   `core/xml.ts` 4 行未在清单中；立即把两者加入门禁并保留红证据 `8583 > 8505`。
   继续删除真实重复契约后，最终又把 Run/Session 的 Plan/Team 构造收回 state port；20 个
   完整生产文件为 `8490/8505`，热点 `mimi-agent/service/store = 1174/1536/1475`，
   ARC-303 两项预算均绿。
5. 完整 coverage 实跑 887/887、fail/skip/todo=0，line/branch/function=
   `88.20%/78.27%/84.53%`；最终 state-port 补丁相关 119/119，随后最终代码的
   `npm test` 再次 887/887。`npm run check`、构建、package 与架构反向门禁全绿；
   `check:repo` 前三项通过，最后一项仅被明确范围外的
   `agent-reach`、`guizang-social-card-skill` 未分类资产阻断；未修改它们。ARC-303 已满足
   实现退出条件，但没有据此越过 Doctor/readiness 门禁部署或建立 T0。
6. 生产收敛已独立提交为 `64a0bca`（72 文件，1921 additions/3594 deletions）；随后从该
   提交建立 detached clean worktree，复用同一 lockfile/dependency tree 执行 `npm run ci`。
   Repository hygiene、release consistency、dependency direction、asset boundary 全绿，
   coverage 887/887、fail/skip/todo=0，line/branch/function=`88.21%/78.27%/84.55%`，
   build 与 package smoke 继续全绿。主工作树两个范围外 Skill 没有进入冻结提交或 CI 样本。

## 2026-08-03 ARC-402：可追溯 clean build 与 T0 防作弊门禁

1. 对照计划 5.2 发现旧 `MIMI_BUILD_VERSION` 只有 package version 与运行文件摘要，无法区分
   commit/dirty。先加入缺失导出的红测，实际为 0/1、ESM 报
   `does not provide an export named 'MIMI_BUILD_IDENTITY'`；实现后 build identity 同时包含完整
   40 位 commit、显式 clean/dirty 和 12 位运行代码摘要，mtime 变化不改变 identity，代码内容
   改变会改变摘要。
2. `npm run build` 现生成严格的 `dist/build-identity.json`；无 Git metadata 失败关闭为
   `unknown + dirty`，stale/损坏 manifest 不借用宿主 Git。安装包 smoke 验证 manifest 被打包、
   schema/package/commit/dirty 与导出的结构化 identity 逐项一致。主工作树实测正确生成
   `bee23c9…/dirty`，没有把未提交代码冒充 clean。
3. Doctor 新增 installed、running、aligned 与可选 workspace HEAD/dirty，只读报告漂移且不重启、
   不修改工作树。真实旧 Daemon 实测 installed=`0.12.0+gbee23c9…dirty.5626583ff91a`、
   running=`0.12.0+54d3940e1185`、aligned=false、workspace dirty=true；漂移进入 issues。
4. 正式 live/soak 又先以缺失 `isTraceableCleanBuildIdentity` 保留 0/1 红证据；现会在调用执行器
   前拒绝 dirty、unknown、working-tree identity，canary 只接受 Doctor 中
   installed=running 的 clean identity，`--build` 不得与运行值不同，跨 build 的证据禁止聚合。
   相关 M1 回归 12/12，Build/Doctor 聚焦回归 6/6，全量 `npm test` 891/891，
   fail/skip/todo=0。
5. 实现已独立提交为 `eea545d`（13 files，379 additions/20 deletions）。首次 clean-CI 调度因
   忘记切入临时 worktree，实际在主工作树运行，前三项绿、范围外两个 Skill 阻断 asset；修正
   cwd 后全套测试虽绿，但进一步检查发现共享 `node_modules` symlink 被 Git 视为 untracked，
   manifest 诚实标为 dirty，因此该次结果未作为冻结证据。
6. 临时 worktree 移除 symlink 后按 lockfile 执行 `npm ci`，Git porcelain 为空；随后真正 clean
   的 `npm run ci` 全绿：四项 repository checks 通过，coverage 891/891、fail/skip/todo=0、
   line/branch/function=`88.24%/78.27%/84.58%`，build/package smoke 通过。最终 manifest 为
   commit `eea545d8d6ae38f24b2763970e23dbffbdc05efe`、dirty=false，包内运行 identity 为
   `0.12.0+geea545d8d6ae38f24b2763970e23dbffbdc05efe.clean.163b8e2cbade`；CI 后 Git 仍为空，
   临时 worktree 已删除。
7. 真实 Doctor 仍为 NO-GO：Computer unavailable（Screen Recording 未授权）、
   `personal-daxiang` offline、`macos-screen` readiness unknown、dead letter=549（37 未分类）、
   Digest=6649。故未安装、未重启、未迁移真实库、未建立 T0，也未运行会被新 clean-build
   门禁拒绝的正式 canary；ARC-402 代码/包门禁完成，运行退出条件继续受外部 readiness 阻塞。
8. 操作审计：本段有一次只读 `git check-ignore ... || :`，虽未掩盖验收结果，也未写状态，
   但与 Goal 禁止吞错的原则不符；已停止使用并如实记录。后续失败命令均保留原 exit/output。
9. `npm ci` 额外提示后执行只读 `npm audit --omit=dev --json`：0 high/critical、2 moderate，
   均来自间接 `@modelcontextprotocol/sdk -> @hono/node-server<2.0.5` 的 Windows `serve-static`
   encoded-backslash advisory；当前验收为 Darwin 且 MimiAgent 未开放该 static route，不阻断本轮，
   但按“不得为本 ARC 改依赖/lockfile”边界未自动升级，留作单独依赖治理。

## 2026-08-03 ARC-402：历史 dead letter 收敛与冻结证据

1. 对照计划 5.3 发现旧分类器输出 `archive_safe / external_blocked / investigate`，与唯一允许的
   `archive / retry_after_fix / blocked / manual_verify` 不一致。先加入反向测试，聚焦结果为
   18/21、3 项失败，实际旧值均为 `investigate`；没有修改断言或把未知记录静默归档。
2. `DeadLetterClassification.disposition` 现只允许计划中的四种值：取消/被替代为 `archive`，
   policy/connector 外部阻塞为 `blocked`，已知可修复错误保留 `retry_after_fix`；缺少结构化失败
   事实为 `unknown/manual_verify`，历史保留记录为 `legacy_failure/manual_verify`。后两者绝不自动
   重放，其中 unknown 仍计入 unclassified 并阻断 Doctor，`manual_verify` 仅表示处置类别，不表示
   已人工核验完成。
3. 实现提交为 `ca7cdaf`。分类、cutover、failure disposition、health 与 diagnostics 聚焦回归
   31/31，`npm run check` 通过；从 ARC-401 的 v16 迁移备份只读 dry-run 共读取 522 条 retained
   dead letter，全部归为 `legacy_failure/manual_verify`，unclassified=0、integrity=ok。
4. dry-run 前后 DB/WAL/SHM SHA-256 完全一致（DB `e4e521…`、WAL 为空文件摘要、SHM
   `fd4c9f…`），证明未归档、未重试、未写库。522 条结构事实仍分别保留为 scheduled 390、
   conversation 75、memory maintenance 56、background 1，未用自然语言错误猜测可重放性。
5. 从提交 `ca7cdafa414a421ae1a96fc4c201cab211f65416` 建立无 symlink 的独立 clean worktree，
   按 lockfile `npm ci` 后确认 Git porcelain 为空，再执行完整 `npm run ci`：四项 repository checks
   通过，coverage 892/892、fail/skip/todo=0，line/branch/function=
   `88.24%/78.25%/84.58%`，build/package smoke 通过。manifest 为该完整 commit、dirty=false，
   包内运行 identity 为
   `0.12.0+gca7cdafa414a421ae1a96fc4c201cab211f65416.clean.d8fecfcbb50c`；CI 后 tracked、
   staged 与 untracked diff 均为空。
6. 本轮没有迁移或修改真实 `~/.mimi-agent` 数据库，也没有安装、部署、重启或建立 T0。真实旧
   Daemon 的 37 条 unclassified 只有在外部门禁恢复、同一 clean build 安全部署并执行受保护的
   v15→v16 迁移后才会按新分类展示；现在仍保持 NO-GO，不能用离线 dry-run 冒充生产收敛。

## 2026-08-03 最终只读运行门禁复核

1. `mimi daemon status --json`、PID、launchd 与 Socket 一致确认旧 Daemon 仍在线且 idle：
   build=`0.12.0+54d3940e1185`，active Event/Task/Tool/Host mutation 与 Outbox pending/sending
   全为 0。一次与 status/connectors 并发的 Doctor RPC 返回 `running=false`，没有启动或停止
   动作；随后的四路检查和串行 Doctor 均证明 PID 63424 从未退出，故只记为只读 probe 瞬时
   false negative，不把它冒充停机或 readiness。
2. 串行 Doctor 仍为 `ready=false`：installed 为旧 manifest 标记的 dirty build，running 为上述
   旧 build，aligned=false；Computer unavailable。Cua Driver 0.16.0 只读 `health_report` 与
   `check_permissions(prompt=false)` 明确为 Accessibility=true、Screen Recording=false、
   overall=degraded，没有触发授权提示。
3. 8 个 enabled Connector 虽然进程 online，但只有 4 个 ready：`personal-daxiang` 渠道
   unavailable，browser 与 macos-shortcuts stale，macos-screen readiness unknown。Task dead
   letter=549，旧运行代码仍报告 unclassified=37；Digest 从 6671 增至 6673，故不满足 Phase 5
   退出条件，也不能建立 T0。
4. 最近一次 scheduled Task 在 Provider 前失败，原因为旧进程缺少 `GENIUSRD_API_KEY`。只读时间
   对比证明 Daemon 于 2026-07-31 18:02 +08:00 启动，而 `.env` 与 `models.json` 于 19:13 后才
   修改；当前配置声明该 credential 且文件中存在，因此这是未重启旧进程的环境快照，不是“本机
   没有配置”。当前源码已用确定性测试覆盖冻结 target 和只转发所选 credential；安全切换后必须
   重新验证真实 Task，不能在旧进程上补算。
5. 操作审计：一次意图只输出 `.env` 变量名的只读正则缺少输出限定，导致四个 Provider 变量的
   值进入本地 Codex 工具回显。值未写入仓库、PROGRESS、BLOCKED 或最终结论，`.env` 仍为 0600；
   但工具回显不能撤销，必须轮换 Geniusrd/MIMI-compatible、DeepSeek 与 Friday 三组外部凭证。
   未擅自删除本机值，因为删除既不能撤销暴露，又会破坏现有服务。
6. 按 ARC-503 布尔合同生成不可覆盖的时间戳化 NO-GO 记录
   `evals/m1/exit-records/20260803T033746+0800-no-go.json`：最终 build 的 live matrix 分母如实为
   requested/eligible/executed=`0/0/0`，T0、24h、72h、7d 均为 null/未通过，历史 build、fixture
   与 readiness 均未补数。JSON 校验和 `git diff --check` 通过，敏感值模式扫描零命中（`rg`
   exit 1），文件 SHA-256=`88c824a2e7f684687fcf8201a1e2bf44c66a758902c7874f8875ee598bd2c5be`。

## 2026-08-03 Owner 强制 clean package 重新部署

1. Owner 明确要求强制重新部署后，从 HEAD `2071c5f03e132d7ff79cc70865cc9484efa1716e`
   建立独立 detached clean worktree，真实 `npm ci && npm run ci` 全绿：四项 repository checks、
   892/892、fail/skip/todo=0，line/branch/function=`88.24%/78.30%/84.58%`，build/package smoke
   通过。tarball SHA-256=`11f81bbbac07fd25fd7cb9cb82c5a134b56da6c8339fcf967415bc6c329a0537`，
   包内 manifest 为完整提交、dirty=false。
2. 切换前旧 build `0.12.0+54d3940e1185` 的 Event/Task/Tool/Host mutation 和 Outbox
   pending/sending 均为 0；另有 1 个 queued Task，但不持有执行权或副作用。使用 SQLite Online
   Backup 创建备份，停止前和移动至持久目录后均验证 integrity=ok。持久备份为
   `/Users/liuyuran/.mimi-agent/backups/m1-force-deploy-20260803T093813`，目录/manifest 权限
   0700/0600，manifest SHA-256=`9d03d0139e9285c1fbc860362ca31d8659cd5a0659e7d78ad4f2c2dcad82a862`。
3. 旧 Daemon 安全停止后，通过 tarball 全局安装，原来指向主工作树的 npm link 已替换为真实
   package directory；新 Daemon PID=54665。串行 Doctor 证明 installed=running=
   `0.12.0+g2071c5f03e132d7ff79cc70865cc9484efa1716e.clean.d8fecfcbb50c`、aligned=true。
4. 启动时接管的 Briefing Task 已真实 completed、Outbox sent，旧进程因环境快照未加载
   `GENIUSRD_API_KEY` 的失败未复现；启动工作结束后 Event/Task/Tool/Host mutation 与 Outbox
   pending/sending 再次全为 0。新分类器在真实状态上得到 dead letter=549、unclassified=0，
   全部历史记录为 `legacy_failure/manual_verify`，没有自动重放或归档。
5. 强制部署只解除 build drift 和旧进程 credential snapshot 两项。Doctor 仍 ready=false：
   Screen Recording=false 导致 Computer unavailable；`personal-daxiang` unavailable，
   macos-screen/macos-shortcuts readiness unknown，Digest=7047，另有 3 个自治来源预算耗尽。
   因此未建立 T0，既有 NO-GO record 不覆盖、不提升；完整部署证据见
   `evals/m1/deployments/20260803T094107+0800-forced.json`。

## 2026-08-03 scheduled worker 运行时修复与第二次强制部署

1. 首次强制部署记录中“credential snapshot 已解除”只被同进程 Briefing 证明，不能外推到
   isolated scheduled worker。真实 scheduled instances `57bd45fc…`、`fb18c16d…` 仍在
   01:45/01:50 UTC 以 36/62ms 在 Provider 前报缺少 `GENIUSRD_API_KEY`；根因是 worker 只在
   `MimiAgent.create()` 期间保留 credential，但模型 client 为 lazy。`e4cf4aa` 将所选 Provider
   与 embedding credential 保留到 Host 完整执行结束，同时继续从 Shell/MCP 环境排除；红→绿
   回归和 clean CI 893/893 通过，tarball SHA-256=`136be09607ab6567aaf8fabb739bd5bc93567539c4f702524b6c5dd82385c0a4`。
2. 修复后 Task `325ce1a6-9224-4b6e-9ce5-6531c7141010` 于
   `2026-08-03T01:55:31.381Z` 真正发出 HTTPS 请求并完成工具路径，但
   `finish_mimi_silently` 最后语义进展 `01:56:09.194Z` 后仍被 Provider 空 metadata stream
   持续刷新 idle watchdog；直到安全切换 `02:44:30.058Z` 才中断，静默持续 2,900,864ms。
   `75f0985` 改为只让可投影的非空 text/status 刷新进展；clean CI 894/894 通过，tarball
   SHA-256=`f3fde82aac3d58690d31c2b572f6efc487862611f5f1c889343cd5d1794144fd`。
3. `75f0985` 上同一 Task 的 attempt 2 从 `02:44:48.816Z` 运行；最后语义进展
   `02:45:40.609Z`，在 `03:05:40.820Z` 自动终止，距 20 分钟阈值仅 211ms，无人工干预、
   无残留 lease。该实测证明空 keepalive 已不再延长 watchdog；同时暴露 SDK 包装 abort 后被
   错分为 `runtime.unclassified / retryable=false`，与错误文案和重试合同冲突。
4. `470f57c` 用本次 Run 的 typed `RunFailureError` sentinel 穿透 SDK 包装；先加 Dispatcher
   integration 回归得到红证据（预期 queued、实际 failed），实现后聚焦 12/12、check 通过。
   detached clean worktree 最终完整 `npm run ci` 为 895/895、fail/skip/todo=0，覆盖率
   line/branch/function=`88.27%/78.35%/84.62%`，build/package smoke 通过。一次复验因既有
   macOS desktop mock state 并发竞态为 894/895；原文件聚焦 2/2 后再次完整 CI 全绿，未修改
   夹具、断言或生产代码；另一个已归档 clean CI log 也为 895/895。最终 tarball SHA-256=
   `bd412884ee0804f1b4ae7e987586533b4b5d1280b65db89531746720c9c5d075`，manifest commit 为
   `470f57c2475cc305be4df6f8c19b31721d0956e7`、dirty=false。
5. 部署前备份 `/Users/liuyuran/.mimi-agent/backups/m1-idle-retry-fix-20260803T112152`
   复验 2,747 文件、SQLite integrity=ok，manifest SHA-256=
   `1499913c63a83892387e556c299ba729291b992f287faedd592624b1c3653ec8`，目录/manifest 为
   0700/0600。边界再次为 active Tool/Host mutation=0、Outbox pending/sending=0；按 Owner
   强制授权只向精确旧 worker PID 2837 与 daemon PID 86550 发送 SIGTERM，attempt 1 被持久化为
   `task.requeued / transient / retryable=true / dispatchStarted=false`，未使用 SIGKILL、未重放
   uncertain 副作用。
6. 新 daemon PID=20520，运行 identity=
   `0.12.0+g470f57c2475cc305be4df6f8c19b31721d0956e7.clean.e260906b23e3`；稳定后 Doctor 证明
   installed=running、aligned=true。启动冷页扫描曾令 status/Doctor IPC 瞬时超时，3 秒 sample
   指向 SQLite covering-index 读取；随后 status/Doctor 均恢复到 1 秒内且进程保持同一 PID，
   未为该瞬时现象改代码或再次重启。线上 attempt 2 已在本 clean build 运行，最后语义进展为
   `2026-08-03T03:24:35.765Z`。
7. 该 attempt 2（Run `1380146b-a547-48e7-bad4-af0b1c84f996`）在
   `2026-08-03T03:44:35.982Z` 自动终止，偏差 1,200,217ms；Task 随即为 queued，failure 精确为
   `runtime.idle_timeout / runtime / transient / retryable=true / dispatchStarted=false`，error 已清空，
   lease=false、worker=null。无人工动作、无 active Tool/Host mutation、Outbox pending/sending=0；
   Supervisor 随后领取其他 queued Task，未把本 Task 错误终结或立即重放。scheduled credential、
   空 keepalive watchdog 与 typed idle retry 三项线上闭环；不可覆盖部署记录为
   `evals/m1/deployments/20260803T114532+0800-worker-runtime-fixes.json`，SHA-256=
   `bc482d63dd95c5c5d3c252aaf6978139c500ab674a681f6469bd436687535401`。

## 2026-08-03 运行队列解锁与实机 readiness 复核

1. 本轮开始时 Daemon 未运行；`mimi daemon start` 已恢复同一 clean build `470f57c`，
   installed=running、aligned=true。随后确认真正挡住只读 probe 的不是文件权限，而是
   `跟踪 personal-daxiang 恢复` watch 每 5 分钟产生新 Task，而 worker 在成功调用
   `finish_mimi_silently` 后仍停留到 20 分钟 idle timeout，形成 1 running + 23 queued。
2. 已删除故障 schedule `bd23c626-2b45-4a8a-8e3c-922b92d4f8ee`；ScheduleStore 同一事务取消
   23 个尚未执行的 queued Task。旧独立 worker 不接受 `restart --force`，通过认证 IPC
   `tasks.cancel` 精确取消 Task `11177868-c60d-44fe-83e6-f4adfc485413`；最终 queued/running/
   active worker 均为 0，没有 active Tool/Host mutation 或 uncertain 外部动作重放。
3. 解锁后正式只读 probe 全部通过：Computer receipt `8b564141…`、Screen `446416ee…`、
   Shortcuts `1ce7508b…`、Browser `f1ad78e5…`。Connector reload 后再次取得 Screen
   `8350d4b1…`、Shortcuts `8f100548…`、Browser `574c59c6…`；Doctor 现报告 Computer
   `operationalReadiness=ready`、enabled Connector ready=7/8、unknown=0。
4. 当前唯一 unavailable Connector 为 `personal-daxiang`：进程 online，但
   `reasonCode=dedicated_tab_unavailable`。脱敏配置检查证明 tab marker、账号/页面指纹、
   self conversation 及 12/12 owner binding 均已配置，因此当前直接缺口是唯一非活动
   `x.sankuai.com` 专用 Chrome 标签不存在或歧义，而不是凭证、账号配置或目标 binding 缺失。
5. Doctor 仍为 ready=false：除大象专用标签外，Digest backlog=7386、3 个自治来源当日预算
   耗尽、历史 dead letter=549（unclassified=0、均为 legacy/manual_verify）；QQ 与个人微信
   正式 route 仍未 operational ready。故尚未建立 T0，100 live matrix 与 24h/72h/7d 不补算。

## 2026-08-03 大象后台自愈与锁屏边界实测

1. `232eacd` 补齐文档已承诺但生产代码缺失的大象后台标签自愈：只有 `health({probe:true})`
   可新建一个 `x.sankuai.com` 标签，立即恢复原 active tab，验证 origin/marker/非活动状态；失败
   只关闭本轮新建标签。回归先红（预期 recovered=true、实际 false），后 28/28 绿；detached clean
   `npm run ci` 为 897/897，tarball SHA-256=`0f19054f6524f945fd9eb031a51e250a5b4963a1dd858c59de630967a26ce7d0`。
2. 备份 `/Users/liuyuran/.mimi-agent/backups/m1-daxiang-recovery-20260803T121630` 经 2,757 文件与
   SQLite integrity=ok 复验后完成安全 stop/install/start。线上 `personal-daxiang` 已为 online、
   inbound/outbound ready、accountVerified/backgroundSafe/targetBound=true，缺专用标签不再是 blocker。
3. 首轮新 build 实测又发现 Finder 桌面 CGWindow 没有对应 AXWindow 时，Computer probe 只尝试
   第一个候选。`10dc7b5` 仅允许初始 probe 跳过 `ax_window_unresolved` 候选；Screen 二次校验的
   exact target 仍 fail-closed，绝不换窗。回归先红后绿，Computer/Probe 55/55、主测试 898/898；
   detached clean CI 898/898，覆盖率 line/branch/function=`88.30%/78.35%/84.62%`，build/package
   smoke 通过，tarball SHA-256=`0afdaf0bacfb80a319b900c309f37965f2f3136a26360373a748fa84ee80927a`。
4. 第二份备份 `/Users/liuyuran/.mimi-agent/backups/m1-computer-probe-20260803T122725` 经 2,753 文件、
   SQLite integrity=ok 复验后部署；当前 installed=running=
   `0.12.0+g10dc7b5edb37545e5a71bb3bb312c217e6079de0.clean.28d15bbc2a85`、aligned=true，PID=76201，
   queued/running/active Tool/Host mutation/Outbox pending/sending 均为 0。Shortcuts receipt
   `7b6406ca…`、Browser `3ccc8776…` 为 eligible live read。
5. Computer/Screen 当前失败的底层条件已由系统状态确认：`IOConsoleLocked=Yes`。Driver 自身
   Accessibility=true、Screen Recording=true，但锁屏下 Finder、后台 TextEdit 与 System Settings
   均暴露 0 个 AXWindow；因此当前 `ax_window_unresolved` 是正确 fail-closed，不是 TCC 或部署故障。
   不绕过 OS 锁；解锁后重跑两个固定 probe。Doctor 仍因该项、Digest=7506、4 个自治来源预算、
   QQ/个人微信正式 Adapter 缺口而 ready=false。完整不可覆盖部署证据见
   `evals/m1/deployments/20260803T123144+0800-daxiang-computer-probe.json`。

## 2026-08-03 历史健康投影压缩、第三次强制部署与 Digest 清零

1. Digest=7506 的主因不是 7506 个待处理业务事实，而是旧大象进程每约 5 秒离线/恢复一次，
   在已经升级为 v16 的库中累计 6857 次状态切换；原 v16 压缩只在 v15→v16 时运行，无法处理
   后续抖动。`e9d06bd` 增加一次性现有-v16 修复：保留全部不可变 Event，只保留每个
   connector+规范 status 的最新待简报投影，启动前备份、单事务写入、计数/SQLite/外键检查、
   审计 marker 幂等。回归覆盖精确保留、Event 不删、只执行一次和完整回滚。
2. 生产只读 dry-run：SQLite integrity=ok、foreign key=0、Event=15,782、Digest=7,506；其中
   connector-health=7,211，15 个分组保留，7,196 可压缩，unclassified=0。detached clean
   `npm run ci` 为 900/900、fail/skip/todo=0，覆盖率 line/branch/function=
   `88.32%/78.41%/84.65%`，架构预算、build、package smoke 全绿；tarball SHA-256=
   `99856c109abb71415e77e5fafa60f49a5a89e0551d1b49d52402c331ba22ad32`。
3. 全量恢复备份 `/Users/liuyuran/.mimi-agent/backups/m1-health-digest-20260803T124913`
   已逐文件复验 2,753 个 manifest entry、SQLite integrity=ok，manifest SHA-256=
   `45dc96d57f64f528a8ad7a192f0b436e68da18e07d2a239d5767994536f5ff9a`。旧进程在 queued/
   running/Tool/Host mutation/Outbox 均为 0 时安全停止；新 PID=98228，installed=running=
   `0.12.0+ge9d06bd8cb75e52b5c6755520c0c38f1ef25f9f4.clean.7364ab4782d6`、aligned=true。
4. 首次启动另自动生成数据库级备份并写入唯一 audit；实库审计 before=7,211、collapsed=7,196、
   after=15、integrity=ok、foreign key=0，Event 删除数=0。启动/探针产生的正常状态边沿与剩余
   真实个人消息共 316 条，没有再做数据迁移；改用四次原生 Owner Briefing，分别处理
   92/95/63/66 条，全部 attempt 1 completed、无错误，最终 Digest=0。
5. 新 build 实测 Shortcuts receipt `ed7308e1…`、Browser `fc12352e…` 成功；大象继续双向 ready，
   accountVerified/backgroundSafe/stable IDs/targetBound=true。Doctor 当前 enabled/online/ready=
   8/8/7，Provider circuit=closed、queued/running/outbox/digest=0。唯一 unknown 为 macos-screen；
   系统仍明确 `IOConsoleLocked=Yes`、`CGSSessionScreenIsLocked=Yes`，Computer/Screen 正确拒绝。
6. 当前仍不建立 T0：4 个真实 24h 自治预算窗口尚未自然滚出，549 条 retained
   legacy/manual_verify dead letter 不授权自动重放/归档；两个旧 blocked schedule Task 的 schedule
   已不存在但仍保留 owner-question 结果，未静默取消；QQ/个人微信正式 route、外部凭证轮换及
   100/24h/72h/7d 仍未完成。完整证据：
   `evals/m1/deployments/20260803T125624+0800-health-digest.json`。

## 2026-08-03 个人微信 Adapter 预检与无人值守续跑

1. 已安装并审计当前 npm latest `@jackwener/wx-cli@0.3.0`；保留官方
   `/Applications/微信.app`，另启动签名副本
   `/Users/liuyuran/Applications/微信-Mimi.app`。`wx init` 可定位 17 个加密数据库和客户端
   task port，但锁屏/未登录状态下得到 0 个候选密钥、0 个匹配密钥；随后
   `wx sessions --limit 1 --json` 精确失败为无法解密 `session.db`。这说明安装路径和进程启动
   已成立，当前读路径缺口是现有登录会话的数据库密钥，不是文件权限。
2. `wx --help` 的真实命令面包含 sessions/history/search/contacts/export/unread/new-messages，
   不包含 send；因此即使 owner 正常解锁并登录、重新 `wx init --force` 后读路径转绿，该工具
   仍不能独立满足 M1 规定的个人微信精确发送和 confirmed readback。未创建只读冒充双向能力的
   Adapter，也未把模糊 chat-name 匹配写成稳定目标绑定。
3. 已启用当前 Codex task 的小时级 heartbeat `MimiAgent M1 长任务续跑`：每轮先只读复核 build、
   idle boundary、锁屏、微信进程和解密状态；解锁后自动重跑 Computer/Screen，微信可读后冻结
   脱敏 schema；没有真实发送后端时继续 fail-closed，不重复部署、不清历史、不重放不确定副作用。

## 2026-08-03 解锁后 Computer/Screen 转绿与微信密钥复验

1. Owner 正常解锁后，系统状态精确变为 `IOConsoleLocked=No`；同一 clean build、同一 daemon
   PID=98228 在 queued/running/active Tool/Host mutation/Outbox pending/sending 全为 0 时执行正式
   只读探针。Computer receipt `1ed39ce1…`、Screen `3bba7242…`、Shortcuts `e0827321…` 全部成功；
   Doctor 已为 Computer operational ready，Connector enabled/online/ready=`8/8/8`，offline/
   unavailable/stale/unknown 全为 0。锁屏与 CUA readiness 不再是当前 blocker。
2. 登录状态下重新执行 `wx init --force`：取得 task port、发现 18 个加密数据库，但进程内存扫描
   仍为 candidate=0、matched=0、stored key=0；`wx sessions --limit 1 --json` 继续精确失败为
   `session.db` 无法解密。因此没有可冻结的会话 schema，也没有读取任何消息内容、账号标识或
   数据库密钥。上游 macOS 文档要求的 `sudo wx init` 不能通过非交互 sudo 执行，未索取或绕过
   owner 密码。
3. 当前 Doctor 仅余自治预算与 retained manual-verify 历史两类风险；probe 产生 4 条正常 Digest
   投影，远低于 `<50` 常态门槛，未为追求 0 而清理。个人微信仍缺 readable session 与真实
   send/readback，故 T0/100/24h/72h/7d 不起算。不可覆盖证据：
   `evals/m1/deployments/20260803T142212+0800-unlock-probes-wechat.json`。

## 2026-08-03 微信账号安全退役

1. Owner 报告腾讯官方外挂警告并明确撤销 MimiAgent 的全部微信能力。该裁决覆盖旧 M1 v2
   的微信 Adapter 要求；计划已修订为 v3，微信从能力族和 soak 前置中删除，改为永久负向门禁。
2. `9f30419` 从 schema、PersonalMessageHub、Connector 模板、默认初始化、脚本、示例桥和当前
   文档中移除微信能力；升级时以 version 3 迁移原子删除旧 `personal-wechat`、
   `openclaw-weixin` 及历史微信 Connector id，后续启动不会补回。detached clean `npm run ci`
   为 893/893、fail/skip/todo=0，覆盖率 line/branch/function=`88.32%/78.41%/84.65%`，build 与
   package smoke 通过；tarball SHA-256=
   `9c1e12349f1a769fb25f7c3a1d355ea2e2efe703cd6fd15ee45f71fd4eb491c1`。
3. 完整备份 `/Users/liuyuran/.mimi-agent/backups/m1-wechat-retirement-20260803T144550`
   已验证 2,757 个 manifest entry、SQLite integrity=ok；manifest SHA-256=
   `e24f8d0db6182cfcf3e95e420f318e29461bd38f8ae667b92bcf397cbb7ae787`。空闲切换后线上运行
   clean build `0.12.0+g9f30419b0e6109feb81776b7d1f4e0427f3fb042.clean.71d220cf5c4d`，
   queued/running/active Event/Tool/Host mutation/Outbox pending/sending 均为 0，Connector 中微信 id=0。
4. 主机侧已停止签名克隆和 `wx-daemon`，卸载 `@jackwener/wx-cli`；克隆 App 与 wx-cli 状态移入
   Trash 可恢复保留，原路径和运行进程均为 0，官方 `/Applications/微信.app` 未修改。
   OpenClaw 的 `mimiagent-bridge` 配置和 load path、`openclaw-weixin` 通道与插件登记均已删除；
   微信插件安装和状态目录移入 Trash 可恢复保留，active path=0，并在配置变更后强制重启
   gateway；没有启动、探测、读取或发送微信来验证退役。
5. 当前 heartbeat 已改为只验证退役，不得执行任何微信动作或重新安装组件。退役后的聚焦回归
   28/28、fail/skip/todo=0；完整不可覆盖证据：
   `evals/m1/deployments/20260803T145419+0800-wechat-retirement.json`。

## 2026-08-03 自治预算恢复窗口不再漂移

1. 生产巡检发现同一来源、同一耗尽原因的重复事件会把 `retryAt` 每次重算为“当前时间 + 窗口”，
   造成预算恢复点持续后移。新增红回归先精确复现：5 项中 1 项失败，第二次事件把同一窗口向后
   推约 35 分钟；修复后相同 reason 保留最早恢复点，reason 改变仍可更新，聚焦 5/5、架构预算
   联测 7/7、全量 893/893，fail/skip/todo=0。
2. 提交 `7a9ca1d` 的 detached clean `npm run ci` 全绿，coverage line/branch/function=
   `88.31%/78.40%/84.65%`，build 与 package smoke 通过；tarball SHA-256=
   `1464e82ae5a8ad46a436ff8e7cd43e04f6ae43abee5691d897822177d451b3cd`。
3. 部署前完整备份 `/Users/liuyuran/.mimi-agent/backups/m1-budget-window-stability-20260803T151300`
   已复验 2,762 个 manifest entry，manifest SHA-256=
   `bec7370450bb00d6a856bae78411bae8a54eb81534e31973957d83ac78b551ab`。仅在 Event/Task/Tool/
   Host mutation/Outbox 全部空闲时切换，线上 PID=78276，installed=running=HEAD，clean build=
   `0.12.0+g7a9ca1d3396a008d7d0653babf310bf4b335333d.clean.7fb8c4804d5b`。
4. 新 build 的 Computer、Screen、Shortcuts 只读探针全部成功；生产中
   `personal-message:daxiang` 与 `system:connector-health` 在新同原因事件后 `retryAt` 逐字节不变，
   证明滑动窗口已停止。没有清理预算、删除 owner 数据、重放 uncertain 动作或操纵恢复时间。
5. 微信永久退役门禁继续成立：runtime 微信 id=0、签名副本不存在、wx-cli 不存在、OpenClaw
   微信 active path=0，验证未接触官方微信客户端。M1 仍未 GO：4 个真实预算窗口需自然恢复，
   549 条 `manual_verify` dead letter 继续保留，QQ inbound/owner canary、live matrix、日历 soak 与
   外部凭证轮换尚未完成。完整证据：
   `evals/m1/deployments/20260803T151643+0800-budget-window-stability.json`。

## 2026-08-03 日预算 1000 与 QQ 定向 canary

1. 日自治 Run 上限已从 100 改为 1000：新增默认值红回归后修改 `src/daemon/attention.ts`、
   `docs/ATTENTION.md`，提交 `db74deb`；运行配置也已原子 reload，部署后 Doctor/Status 均显示
   `maxRunsPerDay=1000`。历史 token accounting 缺失导致的 4 个真实恢复窗口继续保留，没有清空、
   改写或提前释放 owner 数据。
2. QQ 实机发现 3 个同 PID、同标题的重叠 compositor surface；旧 Adapter 会直接报目标歧义。
   提交 `69f8b14` 现在只接受唯一语义窗口及其 90% 以上包含的 unresolved compositor surface，
   对独立窗口仍 fail-closed。包含面与独立面回归均已覆盖，QQ 聚焦测试 7/7。
3. Owner 指定的唯一测试目标“我的好乖乖”在动作前精确匹配 1 次；草稿 hash 回读一致后只按
   Return 1 次，随后同文本在该目标的会话预览与消息区可见，未观察到错目标。由于发送后 AX tree
   不再暴露 composer，无法同时证明输入框清空，因此按 uncertain/no-replay 处理，未再次按键，
   也不把这次 Codex Computer Use canary 冒充 Mimi 正式 `PersonalMessageHub` live_action。
4. 真正剩余根因是 `cua-driver 0.16.0` 的窗口级 AX 映射：可解析的 QQ 主窗口能看到精确会话，
   但 writable composer 位于另一个 `ax_window_unresolved` 合成面；当前 driver 无 application-wide
   AX API。按计划禁止用 Shell/JXA、硬编码坐标或视觉猜测替代正式 CUA，所以 QQ inbound observer、
   安全 send/readback 仍为 `implemented_blocked`。
5. 最终 HEAD `69f8b14` 完整测试 896/896；detached clean CI/package 全绿，覆盖率
   line/branch/function=`88.33%/78.37%/84.66%`，tarball SHA-256=
   `8ef13188c0cbef1b2756d7dc2060f0d838771bc8aa275c0409c5b7a39077a232`。完整备份
   `/Users/liuyuran/.mimi-agent/backups/m1-budget-1000-20260803T153335` 验证 2,759 个 entry、
   SQLite integrity=ok；空闲切换后 installed=running=HEAD，Computer/Screen/Shortcuts 正式只读
   probe 全绿，7/7 enabled Connector ready。微信退休门禁继续成立且未接触官方客户端。
6. Doctor 仍非 GO：4 个历史自治 token/Run 窗口等待真实滚出，549 条 retained
   `manual_verify` dead letter 不重放；QQ 正式 inbound/send/readback、100 live matrix、24h/72h/7d
   与外部 Provider 凭证轮换尚未完成。证据：
   `evals/m1/deployments/20260803T155008+0800-budget-qq-canary.json`。

## 2026-08-03 CUA application-composite AX 上游 RFC

1. 对当前 latest `cua-driver 0.16.0`、公开工具 schema、macOS AX walker 源码及相邻 issue/PR 做了
   脱敏复核。结论是：精确 `(pid, window_id)` 对 `ax_window_unresolved` fail-closed 属于预期安全
   合同，但应用级 AX 元素无法归属任一 CGWindowID 时没有公开、可安全动作的语义 scope；该缺口
   真实、通用且不应通过恢复最大窗口启发式、PID-only action 或桌面级 element index 绕过。
2. 已按 CUA 强制 RFC 流程创建公开讨论
   `https://github.com/trycua/cua/issues/2807`，内容只含版本、脱敏 surface 拓扑、公开源码/issue
   及安全验收，不含联系人、消息、账号、截图或应用内容。
3. 已创建 fork 与独立分支 `rfc/2807-application-composite-ax-scope`，提交
   `882e279b0`、`aee32018a`，并创建仓库内 RFC 文档 PR
   `https://github.com/trycua/cua/pull/2808`。新 RFC 文件通过 pinned Prettier 与
   `git diff --check`；全仓 `pnpm prettier:check` 精确暴露上游已有 285 个格式漂移文件，未修改
   任何无关文件来掩盖基线。PR contributor-attribution 已成功；其余 3 个 workflow 正等待
   maintainer approval，页面明确 `Review required`，不是代码或权限失败。
4. 上游规范要求公开协议/跨平台合同在 RFC 被接受前不得实现，因此当前没有修改 CUA 生产代码，
   也没有把提案冒充可用能力。QQ 正式闭环继续 fail-closed；下一步由 #2807/#2808 维护者评审
   决定 API shape、read-only 首发和跨平台 capability 语义。证据：
   `evals/m1/deployments/20260803T162656+0800-cua-rfc.json`。

## 2026-08-03 普通 Host CUA 生命周期修复、推送与强制部署

1. `bef1355` 让所有普通 Mimi Host 在创建 RuntimeComponents 时启动并持有共享 Cua Driver
   lifecycle，同时把 Skill catalog 的正式 `inspect_capabilities`→`invoke_capability` 调用合同和
   “禁止模型用 Shell/nohup 自行启动 Driver”写入运行时指令；新增普通 Host lifecycle 回归。
   `a53d4f7` 提交此前 QQ/budget/CUA RFC 审计证据。范围外 `AGENTS.md`、旧蓝图、wiki log、
   两份计划副本和两个未分类 Skill 继续原样保留。
2. 聚焦 core/route 77/77、Computer 51/51、`npm run check` 通过；本工作树 `npm run ci` 仅因两个
   明确排除的未跟踪 Skill 未登记 asset manifest 而在测试前失败。随后从 `a53d4f7` detached clean
   worktree 执行 `npm ci && npm run ci` 全绿，coverage line/branch/function=
   `88.38%/78.51%/84.79%`，clean build 与 package smoke 通过。
3. 分支 `codex/mimiagent-integrated` 已推送 `531850d..a53d4f7`，复核 origin...HEAD=`0/0`。
   clean tarball SHA-256=`3f0895bee31ef5185fbce782aef01ff74fc8e96d211ae68f01d7624e5471d247`；
   build identity commit=`a53d4f7dc6b3057b5a2522669054969e18b3e0d8`、dirty=false。
4. 部署前正式备份 `/Users/liuyuran/.mimi-agent/backups/m1-host-lifecycle-20260803T164045`
   已通过 backup verify，2,780 个 manifest entry、manifest SHA-256=
   `bbcf3041f3d4d0d1e58d7e5d268c415098a95408cc7032b8e8573d78a1b50d9c`、SQLite integrity=ok。
   安装同一 tarball 后在 Event/Task/Tool/Host mutation/Outbox 全部空闲时执行
   `mimi daemon restart --force`；新 PID=68489，installed=running=
   `0.12.0+ga53d4f7dc6b3057b5a2522669054969e18b3e0d8.clean.ade23887a02f`。
5. 部署后 Provider closed、日 Run 上限 1000、远端对齐、Daemon idle；Shortcuts 正式只读 probe
   成功。当前控制台 `IOConsoleLocked=true`，Computer/Screen 对 TextEdit 合成面按
   `ax_window_unresolved` fail-closed，故只记录外部锁屏边界，不重复部署或放宽验证。微信退休门禁
   继续成立：Connector match=0、wx-cli=0、签名副本=0、退休进程=0，未接触官方客户端。证据：
   `evals/m1/deployments/20260803T164435+0800-forced-host-lifecycle.json`。

## 2026-08-03 Owner 快速收口裁决与 M1 eval v4

1. Owner 接受“QQ 不再阻塞 M1、忽略固定时间验证”的快速收口建议。唯一计划升级为 v4：QQ
   保留默认关闭、fail-closed 的实验 CUA route并继续跟进上游 RFC；微信永久退休不变；M1 正式
   分母改为 Browser/Computer/Screen/Shortcuts/Daxiang 五族 30 次短 live matrix（8/8/4/4/6），
   24h/72h/7d/30d 移为 M2 发布质量信号，不能用 fixture/readiness 冒充 live action。
2. `npm run eval:m1` 先真实复现 `browser.execute.javascript-removed has invalid boundaryRef`；根因是
   manifest 有 3 个 config/example 引用不符合 runner 的 `tests/*.test.ts` 边界，且数据集没有 QQ
   默认关闭和微信退役负向场景。v4 manifest 修复后 64 个 fixture 全部执行完成，requested/
   eligible/executed=`64/42/42`，没有 runner failure；新增回归要求所有 boundaryRef 可执行。
3. 新增正式 `daxiang-health` 只读 probe，并把 installed closeout canary 固定为 30 个正式样本；
   receipt 只保留 Manager 边界和计数，不持久化账号、目标或正文。live evidence schema 同时允许
   `read|write`，后续写样本仍必须由正式业务回执生成，不能由只读 canary 补数。
4. safely throttled 的 pre-T0 自治预算窗口与已分类 legacy dead letter 继续显示在 health/audit，
   但不再阻断 owner 工作或 Doctor；unclassified、Connector、Computer、Provider、错目标和
   uncertain no-replay 门禁不变，绝不清空、重放或提前释放历史状态。
5. 当前工作树 `npm run check` 通过；聚焦 149/149；首次全量 897/898 仅 CUA lifecycle 500ms
   同步断言在整机负载下红，精确复跑绿；第二次完整 `npm test` 稳定 899/899、skip/todo=0。
   本轮尚未提交、部署或执行 live matrix，必须继续 clean CI/package、备份、空闲切换后取证。
