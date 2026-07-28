# MimiAgent 三档 Security 轻量化管控改造计划

日期：2026-07-28
状态：已实施并完成工程与真实环境验收
适用范围：当前 `codex/mimiagent-integrated` 工作树
关联问题：`docs/audits/20260728-MimiAgent-能力路由误裁剪与Shell绕过Badcase问题文档.md`

实施结果（2026-07-28）：

- 三档 Security 已成为 Owner Run 唯一授权来源，旧 permission/一次性授权只读兼容；
- Workstation 已启用结构化沙箱 Shell，并移除 Connector 外部事务与 Computer；
- 模型 Connector 面已收敛为快照、inspect 和 `invoke_capability`，不能启停/重载；
- `macos-desktop` 默认 action-only 启用，新增 `open_visible`，显式激活精确 bundle ID 并做后置可见确认；
- 粗粒度 Connector 应用占用不再参与 Computer 授权；
- `npm run check`、691 项全量测试、build、package smoke 和 focused regression 均通过；
- 真实打开 `/Users/liuyuran/neon-survivor/index.html` 验收返回 `confirmed`，Chrome 前台、
  窗口可见且标题匹配；未运行需要真实 Provider 凭证的 opt-in eval。

## 1. 结论

MimiAgent 只保留 `Safe`、`Workstation`、`Full Owner` 三种用户可见安全策略，并把
`SecurityProfile` 设为 Owner Run 的唯一授权来源。

当前的 `AgentPermissionMode`、Mode 工具裁剪、RunPolicy capability/tool allowlist、
`ComputerAccess` 四档授权、Connector 整应用 route owner、ActionIntent 一次性审批共同
形成了多套相互叠加的权限体系。单项防线大多有合理来源，但组合后导致：

- 同一 Owner 指令因措辞、来源、Connector 状态或执行顺序不同而获得不同工具面；
- Agent 需要通过 Shell、Computer、Connector 连续失败才能发现正确执行路径；
- `Full Owner` 已经授权的普通动作仍可能被 Computer/Connector 二次拒绝；
- Workstation 能发送 Connector 外部事务，却不能运行本地构建 Shell，语义不直观；
- “已接收”“已执行”“用户可见”混为完成，产生假完成；
- 安全逻辑分散在多个模块，修一个 Badcase 容易增加下一层卡控。

改造后，权限问题只回答一个问题：当前三档 Security 是否允许该能力。路由、目标校验、
Shell 沙箱、窗口 Observation、原子存储和防重复台账继续保留，但它们只保证执行正确，
不再成为新的授权策略。

## 2. 改造目标

1. Owner 在相同 Security 档位下始终获得相同基础能力，不受自然语言关键词影响。
2. 一条普通动作最多经历一次能力选择和一次执行，不再跨 Shell、Computer、Connector
   试错。
3. Security 明确拒绝时一次返回可解释结果，不尝试权限更宽或语义不同的替代路线。
4. Security 允许但能力未就绪时返回真实依赖问题，不把“未启用”“离线”误报为无权限。
5. 所有外部或 GUI 副作用继续满足 at-most-once；取消、超时、断连后的不确定动作不重放。
6. 工具只有获得目标后置条件证据才可报告完成。
7. 删除重复策略和数据结构，不建立新的审批中心、规则 DSL、工作流或意图关键词表。

## 3. 不可删除的底线

下列机制不是第四种安全策略，必须保留：

- **来源隔离**：外部/public 内容永远不能继承 Owner 的 Full Owner 权限。
- **作用域约束**：后台任务、SubAgent、Team worker 不能超出创建者授予的工作区、目标和
  生命周期。
- **Shell 能力隔离**：通用 Shell 继续禁止 Apple Events、LaunchServices、Accessibility
  和已登记控制面；GUI 必须走结构化能力。
- **目标正确性**：GUI 写动作必须使用新鲜精确目标，保护 Terminal、Codex、IDE 等控制面，
  并阻止坐标越界、密码框输入和前台目标漂移。
- **结果正确性**：副作用只有 `confirmed`、`failed_safe`、`uncertain` 三种终态；
  `uncertain` 不能换路或重放。
- **持久状态可靠性**：Session、Task、Outbox、Memory、Ledger 继续原子写入并校验 run/owner。

这些机制只可缩小目标或阻止错误执行，不能在 Security 已允许时另行决定“Owner 是否有权”。

## 4. 当前复杂度基线

当前源码和测试中：

- `AgentPermissionMode`：12 个文件、33 处引用；
- `RunToolPolicy`：3 个文件、7 处引用；
- `allowedCapabilities`：11 个文件、30 处引用；
- `allowedSideEffectTools`：6 个文件、15 处引用；
- `ComputerAccess`：7 个文件、37 处引用；
- `OneTimeActionAuthorization`：4 个文件、8 处引用；
- `claimedComputerApps`：9 个文件、17 处引用；
- 核心策略相关文件合计约 1509 行，其中 `src/daemon/policy.ts` 553 行。

同一 Run 的 Tool 至少经过 `toolsForPermission`、`toolsForRunPolicy`、`toolsForMode` 和
Computer enable/access 等多轮过滤；`src/runtime/mimi-agent.ts` 又在不同构造阶段重复过滤。
这正是“配置上允许、最终工具却消失”难以解释的主要原因。

## 5. 唯一安全模型

### 5.1 三档含义

| 能力 | Safe | Workstation | Full Owner |
| --- | --- | --- | --- |
| 工作区文件 | 只读 | 工作区内读写 | 按当前 OS 用户和既有路径保护读写 |
| Shell | 无 | 工作区沙箱 Shell | Full Owner 沙箱 Shell |
| 公网读取 | 允许 | 允许 | 允许 |
| 任意网络写入 | 禁止 | 仅本地开发目标，不含账号事务 | 允许 |
| Memory/Session/Plan | 只读 | 当前 Owner 工作状态读写 | 全部 Owner 能力 |
| Connector 外部事务 | 禁止 | 禁止 | 允许 |
| Computer/桌面写入 | 禁止 | 禁止 | 允许 |
| 受信工作区 MCP | 禁止 | 禁止 | 允许 |
| 临时敏感值 | 禁止 | 禁止 | 当前 Owner Run 内允许 |

Workstation 的定位调整为“能完整开发当前工作区，但不能代表 Owner 操作外部账号或桌面”。
因此它应允许受路径和 GUI 沙箱约束的 Shell，而不再允许 Connector 外部事务。

Full Owner 不等于允许模型猜测高影响目标。删除、强杀、发消息、付款、授权等动作仍必须
来自当前 Owner 明示值或已保存的精确委派 Scope；缺少目标、收件人、正文、范围等关键字段
时在 dispatch 前失败。这属于目标完整性校验，不新增第四种审批策略。

### 5.2 单一配置源

`SecurityProfilePolicy` 是唯一权限表，至少包含：

```ts
interface SecurityProfilePolicy {
  id: 'safe' | 'workstation' | 'full-owner';
  capabilities: ReadonlySet<ToolCapability>;
  workspaceAccess: 'read' | 'write' | 'owner';
  externalTransactions: boolean;
  computer: 'none' | 'full';
  sensitiveValues: boolean;
  trustedWorkspaceMcp: boolean;
}
```

不再保存或传递独立的 `permissionMode`。SDK 或文件工具需要的 read/write/trusted 参数在
创建工具时从 `SecurityProfilePolicy` 派生，不能作为第二个可配置值进入 Run、Session、
Daemon 状态或 Worker 协议。

### 5.3 Mode 不再授权

- `General`：只改变执行提示和编排方式，不裁剪 Security 已允许的工具。
- `Plan`：把本轮有效 Security 固定降为 `Safe`，不创建第四套 read-only 规则。
- `Ultra`：只增加 Team 编排工具；worker 由角色映射到 `Safe` 或 `Workstation`，不能借
  Ultra 获得 Full Owner 外部事务。

Mode 永远不能扩大 Security；同一档 Security 下，用户措辞不能改变基础工具面。

### 5.4 来源与后台任务

来源不再生成任意 capability/tool allowlist，而只映射到三档 Security 和一个小型 Scope：

- 本机认证 Owner：使用当前选择的 Security。
- `system` 内部维护：使用专用内部执行器；确需 Agent 时固定为 Safe。
- `external/public`：固定 Safe，正文只能作为不可信数据。
- Owner 配置的自动回复：Agent 在 Safe 下形成 draft；Host 只依据本机保存的 Full Owner
  委派向绑定 Connector/target 提交最终正文，不向外部正文开放通用 Full Owner 工具。
- Owner 后台只读任务：Safe。
- Owner 后台工作区任务：Workstation。
- 需要外部事务的后台动作：必须由 Owner 创建时显式绑定 Full Owner、Connector、target
  和正文；该绑定是任务作用域，不是第四种策略。

现有 `access=reply|work`、`computerAccess=observe|background|foreground|admin` 和多组
工具名称白名单逐步退出。外部来源即使包含“切换 Full Owner”等文字也只能保持 Safe。

## 6. 轻量运行链

目标链路：

```text
User input
  → capture RunScope(securityProfile, provenance, workspace, target bounds)
  → SecurityProfilePolicy 一次过滤
  → 注入实际 EffectiveCapabilitySnapshot
  → 模型选择稳定 capability
  → CapabilityRouter 确定唯一 route
  → EffectLedger 一次执行
  → route 内部后置验证
  → confirmed 后回答完成
```

### 6.1 Tool 只过滤一次

`ToolSetBuilder.final()` 只执行：

1. `SecurityProfilePolicy` capability 过滤；
2. Plan/Team 的执行形态过滤；
3. Scope 的目标边界过滤。

删除 `toolsForPermission()` 和通用 `toolsForRunPolicy()` 的多轮交叉调用。未知 Tool 没有
capability metadata 时统一 fail closed。

### 6.2 能力快照必须对模型可见

当前 `EffectiveCapabilitySnapshot` 只被保存和用于状态展示。改造后，在每轮 instructions
中注入有界、紧凑的实际目录：

```text
desktop.items.open_visible
  availability=ready
  route=macos-desktop
  effect=write
browser.page.read
  availability=ready
  route=macos-browser
  effect=read
```

只展示当前 Security 已允许的 capability；不展示实现命令、凭证或内部 socket。
`query` 仅用于人工检索，不能再承担首次路由发现。

### 6.3 统一 capability 执行入口

模型使用一个结构化入口调用 Connector 能力：

```ts
invoke_capability({
  capability: 'desktop.items.open_visible',
  target: '/absolute/path/index.html',
  payload: { bundleId: 'com.google.Chrome' }
})
```

`CapabilityRouter` 根据快照选择唯一 ready route。模型不再先猜 Connector ID，再调用
`set_mimi_connector_enabled`，最后拼接 `connector_action`。

- `inspect_mimi_capabilities` 保留为只读诊断工具，但普通动作不强制先调用。
- `set_mimi_connector_enabled`、`reload_mimi_connectors` 从模型基础工具面移除，仅保留
  `/connectors` operator 命令。
- `macos-desktop` 作为 action-only、默认无轮询的本机执行面随 Daemon 启用；Security
  仍决定其 action 是否暴露。
- Connector 未就绪时一次返回 `capability_unavailable` 和真实原因，不自动跨路线。

### 6.4 route owner 改为能力级路由

删除整应用级 `claimedComputerApps` 拒绝。`personal-daxiang` 只拥有其已绑定的专用标签和
`personal-message.*` capability，`macos-browser` 只拥有 `browser.*` capability，
`macos-desktop` 拥有 `desktop.items.*`。

“Chrome 被某 Connector 使用”不能阻止另一个已授权 capability 打开无关本地文件。
真正的重复动作由 EffectLedger 的相同 effect key 阻止，不由应用级黑名单阻止。

### 6.5 EffectLedger 取代审批型 ActionIntent

保留现有 `ExecutionLedger` 文件和原子存储，删除：

- `OneTimeActionAuthorization`；
- guarded owner fast path 与一次性审批二选一；
- Tool 内外两层 `executeActionIntent → executeOnce` 嵌套；
- 把 Security、route owner 和 Ledger 混在一起的授权判断。

副作用 Tool 只提供：

```ts
interface EffectMetadata {
  family: string;
  targetRef: string;
  payloadDigest: string;
  workRevision: string;
}
```

Ledger 生成稳定 effect key，并只记录：

- `started`
- `confirmed`
- `failed_safe`
- `uncertain`

Security 在 dispatch 前已经完成授权；Ledger 只负责同一业务动作最多执行一次。取消、超时、
子进程退出或回执丢失统一结算为 `uncertain`。

### 6.6 完成只认后置条件

删除用户可见完成判断中的 `accepted`、`applied`、`opened:true`。它们可作为 route 内部
中间状态，但不能结束任务。

每个写 capability 声明最小后置条件。例如：

- `desktop.items.open_visible`：目标绝对路径匹配、目标 bundle ID 匹配、精确窗口存在且
  `frontmost=true`；
- `personal-message.send`：稳定 target 匹配、返回新的 outgoing message ID；
- 文件写入：目标路径、内容 digest 和原子替换结果匹配；
- Browser 导航：精确 tab ref 重新读取后的 URL 匹配。

无法取得后置证据时结果必须是 `uncertain` 或 `failed_safe`，不得用自然语言补成“已完成”。

## 7. “打开我看看”改造后的标准行为

前置：Owner 选择 Full Owner，`macos-desktop` ready，文件存在。

```text
打开我看看
→ 快照中直接看到 desktop.items.open_visible
→ invoke_capability 一次
→ macos-desktop 使用 bundle ID 打开文件
→ Connector 内定位并验证目标窗口前台可见
→ EffectLedger confirmed
→ 回答“已打开”
```

必须满足：

- 不调用 `run_shell open`；
- 不先调用 `computer_act launch_app`；
- 不因大象或 Browser Connector 使用 Chrome 而拒绝；
- 不持久修改 Connector enabled；
- payload 未知字段在 dispatch 前报错；
- 未验证窗口前台时不能回答用户“已经看到”；
- Safe/Workstation 下只返回一次 `denied_by_security`，不尝试其他路线。

## 8. 代码改造边界

### 8.1 Security 单一来源

- `src/config.ts`
  - 保留 `SecurityProfile` 和三档表；
  - 删除生产态 `AgentPermissionMode`；
  - 旧 `MIMI_PERMISSION_MODE` 只做一次兼容映射并输出废弃提示；
  - 修正 Workstation 的 Shell/外部事务语义。
- `src/runtime/tool-policy.ts`
  - 合并为单个 `toolsForSecurity()`；
  - Mode 只保留 Plan 降 Safe 和 Ultra orchestration。
- `src/runtime/pipeline/run-scope.ts`
  - 删除 `permissionMode`；
  - 保留 provenance、workspace 和目标 scope。
- `src/runtime/pipeline/tool-set-builder.ts`
  - 删除重复过滤，最终工具集只构造一次。
- `src/runtime/mimi-agent.ts`
  - 每轮冻结一个 Security；
  - 把真实 capability snapshot 注入 instructions；
  - `/security` 仍只显示三档。

### 8.2 Daemon 来源收敛

- `src/daemon/policy.ts`
  - 删除 `READ_TASK_*`、`WORK_SOURCE_POLICY_*` 等大型工具名数组；
  - 来源只映射 `effectiveSecurityProfile + RunScope`；
  - 自动回复和维护任务改用专用 Host tool bundle。
- `src/daemon/worker-protocol.ts`、`src/daemon/types.ts`
  - 只传 `securityProfile`；
  - 后台任务的 read/write 映射为 Safe/Workstation。
- `src/daemon/service.ts`、`src/daemon/chat-client.ts`
  - Daemon 复用与状态比较不再同时比较 permissionMode。

### 8.3 Connector 与桌面路由

- `src/daemon/connector-action-tool.ts`
  - 增加 model-facing `invoke_capability`；
  - enabled/reload 管理退出基础工具面。
- `src/daemon/connectors.ts`
  - 按 capability 解析唯一 route；
  - 删除整应用 `claimedComputerApps` 授权语义。
- `examples/connectors/macos-desktop-connector.mjs`
  - payload 使用严格 action schema，拒绝未知字段；
  - 增加 `open_visible` 和精确后置验证；
  - 使用 bundle ID，不用自然语言应用名猜测。
- `mimi.connectors.example.json`
  - 发布 `desktop.items.open_visible`；
  - `macos-desktop` 作为无轮询 action-only 执行面默认启用；
  - Personal/Browser Connector 只声明自己的 capability。

### 8.4 Computer 与副作用台账

- `src/extensions/computer/manager.ts`
  - 删除 `ComputerAccess` 作为第二授权；
  - Security 之外只保留 Observation、目标新鲜度、控制面保护、前后台状态和动作预算；
  - foreground/admin 不再要求另一套 approval，Full Owner 直接按结构化目标执行。
- `src/core/action-intent.ts`
  - 删除一次性授权和授权决策；
  - effect key/receipt 可并入 `execution-ledger.ts`。
- `src/runtime/tool-ledger.ts`、`src/core/execution-ledger.ts`
  - 一次包装、一次落账；
  - 保留 confirmed/failed_safe/uncertain 与崩溃恢复。

### 8.5 文档与公共契约

- 同步 `README.md`、`docs/ARCHITECTURE.md`、`docs/COMPUTER_USE.md`、
  `docs/CONNECTORS.md`、`.env.example`、`CHANGELOG.md`；
- 删除“permission mode 是独立授权层”“Computer 四档 approval”“整应用 route owner”等
  过时描述；
- 保留三档 Security、Shell 结构化隔离、目标验证和 at-most-once 的清晰说明。

## 9. 实施阶段

### 阶段 A：建立三档真值表

1. 为当前全部 Tool 补齐 capability metadata。
2. 新增 `toolsForSecurity()` 和三档矩阵测试。
3. RunScope/状态输出只认 `securityProfile`。
4. 暂时保留旧字段读取兼容，但禁止旧字段参与决策。

验证：相同 Security、不同自然语言和 Session 的基础工具集 digest 完全一致。

### 阶段 B：移除重复裁剪

1. 删除 `AgentPermissionMode` 运行态传递。
2. 删除通用 RunPolicy 工具名/capability 交叉裁剪。
3. 把外部、后台、Plan、Team 映射到三档 Security + Scope。
4. 将 `src/daemon/policy.ts` 中专用维护/回复工作迁到窄 Host tools。

验证：所有 prompt-injection fixture 仍 fail closed；Owner 复合指令不再整轮丢工具。

### 阶段 C：统一 capability 路由

1. 注入实际 capability snapshot。
2. 增加 `invoke_capability`。
3. 移除模型侧 Connector 启停动作。
4. 删除 `claimedComputerApps`，按 capability/target 选路。
5. 完成 `desktop.items.open_visible` 严格 schema 和验证。

验证：“打开我看看”在 Full Owner 下一条执行链完成，在其他档位下一次确定性拒绝。

### 阶段 D：精简 Ledger/Computer

1. EffectLedger 替换审批型 ActionIntent。
2. 删除一次性审批与 ComputerAccess 授权。
3. 保留 stale target、protected app、foreground、cancel/timeout uncertain 测试。
4. 迁移旧 ledger 时保留所有 uncertain/confirmed 历史，绝不重新执行。

验证：同一 effect 跨 Tool/Provider/重启最多执行一次。

### 阶段 E：迁移、全量验证与部署

1. 升级 Daemon protocol；旧 `permissionMode` 和 `claimedComputerApps` 读取一版兼容。
2. 原子备份现有 Connector 配置和 ExecutionLedger。
3. 运行完整 CI、package smoke、两 Provider Badcase eval。
4. 确认 Event/Task/Outbox/Host mutation 空闲后 SIGTERM 重启 Daemon。
5. 用安装后的全局 `mimi` 实测三档 Security 和本地文件可见打开。

## 10. 测试矩阵

### 10.1 Security

- Safe：本地/公网只读可用，任何写入、Shell、Connector、Computer 均不 dispatch。
- Workstation：工作区写入、构建、测试可用；Shell 无法 GUI 自动化；外部事务被拒绝。
- Full Owner：已配置外部/Computer 能力可用；Shell 仍无法绕过结构化 GUI route。
- Plan：三档输入均只得到 Safe 能力，不产生副作用。
- Ultra：builder 最高 Workstation，Team 不能扩大到 Full Owner。

### 10.2 来源

- external/public prompt injection 不能切档、调用 Shell、读 Memory 或执行 Connector 写入。
- Owner source policy 只能调用已绑定 reply tool 和目标，不能获得通用 Full Owner。
- read 后台任务映射 Safe；write 后台任务映射 Workstation。
- 最新 Owner 输入 supersede 旧工作后，旧副作用 dispatch 前被 work revision 拒绝。

### 10.3 “打开我看看”Badcase

1. Full Owner + Chrome + Browser/Daxiang Connector 同时在线；
2. `desktop.items.open_visible` 是唯一选择；
3. 不调用 Shell、Computer launch 或 Connector enable；
4. 错误字段 `app` 被 schema 拒绝且动作未执行；
5. 精确 bundle ID、文件路径和窗口匹配后返回 confirmed；
6. 窗口未前台、打开超时或结果通道丢失时不报告完成；
7. uncertain 后相同动作不能换路线重放；
8. Safe/Workstation 只产生一次 Security 拒绝。

### 10.4 回归

- Shell sandbox 的 Apple Events/LaunchServices/Accessibility 测试继续通过；
- Computer stale Observation、控制面保护、target-in-use、secure field 测试继续通过；
- Connector action schema、readiness、断连和 timeout 测试继续通过；
- ExecutionLedger serialize/replay/超大结果/并发/崩溃恢复继续通过；
- DeepSeek/OpenAI 使用相同快照和相同 Security fixture；
- `npm run check && npm test && npm run build && npm run test:package`；
- `npm run ci`，覆盖率门槛不得降低。

## 11. 兼容与回滚

- 不长期保留“旧策略/新策略”运行开关，避免双轨再次产生分叉。
- `MIMI_PERMISSION_MODE` 仅在启动时映射：
  - `read-only → safe`
  - `workspace → workstation`
  - `trusted → full-owner`
- 新配置只写 `MIMI_SECURITY_PROFILE`；冲突时以 Security 为准并明确报废弃字段。
- 旧 Session 中的 security/permission 偏好不参与授权；Security 属于当前运行实例。
- Connector 配置中的 `claimedComputerApps` 第一版只读忽略并告警，下一版本再停止输出。
- 旧 Ledger 只迁移状态，不把 `started/uncertain` 转成可执行。
- 部署前备份配置和 Ledger；回滚只恢复旧二进制和兼容配置，不能清空或重置台账。

## 12. 量化验收标准

1. 用户可见安全策略只有 Safe、Workstation、Full Owner 三档。
2. `AgentPermissionMode`、`RunToolPolicy.allowedCapabilities`、
   `allowedSideEffectTools`、`OneTimeActionAuthorization`、`claimedComputerApps` 在生产决策
   路径中均为 0 处引用。
3. Computer 不再存在 observe/background/foreground/admin 四档授权；这些词只可作为动作
   交付属性或彻底删除。
4. 最终 Tool 只过滤一次；同 Security 的 Owner Run 工具集 digest 不受输入措辞影响。
5. `src/daemon/policy.ts` 不再维护大型工具名数组，策略主体减少至少 50%。
6. `Full Owner + 打开本地 HTML 给我看`：
   - 0 次 Shell GUI 调用；
   - 0 次 Connector 持久启停；
   - 0 次 Computer launch 试错；
   - 1 次 capability dispatch；
   - 取得精确前台窗口证据后才回答完成。
7. Safe/Workstation 对同一请求只返回一次 `denied_by_security`，无副作用调用。
8. Browser/Daxiang 使用 Chrome 不影响无关 `desktop.items.open_visible`。
9. 错误 payload、目标不新鲜、窗口不可见和回执丢失均不能产生 confirmed。
10. uncertain 动作跨 Tool、Provider、重启均不自动重放。
11. 外部/public 内容无法通过任何文字改变 Security 或扩大 Scope。
12. 全量功能测试、构建、package smoke、两 Provider Badcase eval 通过，覆盖率门槛不降低。

## 13. 明确不做

- 不新增 Approval Center、Mandate、Policy DSL、风险评分器或规则编排平台；
- 不根据“打开、发送、搜索”等自然语言关键词裁剪工具；
- 不为每个 App、Connector 或 Tool 创建独立安全档位；
- 不把 Connector enabled/online 当授权；
- 不删除 Shell 沙箱、目标验证、原子存储或防重复台账；
- 不扩大 SubAgent/Team/外部事件权限；
- 不借本次改造重构 Session、Memory、Goal、Plan 或 Daemon 持久化架构。

## 14. 建议默认决策

本计划建议直接采用以下三项，不再为其增加配置开关：

1. Workstation 调整为“允许工作区沙箱 Shell、禁止 Connector 外部事务”；
2. `macos-desktop` 作为无轮询 action-only Connector 默认随 Daemon 启用；
3. Full Owner 取消逐动作一次性审批，以 Security + 精确目标 + EffectLedger 为边界。

Owner 明确要求“按照计划实施”后，即按 A → E 顺序执行；不再设计新的安全框架。
