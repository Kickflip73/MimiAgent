# MimiAgent 多 Provider、多模型动态路由最终实施方案

日期：2026-07-29

状态：最终实施稿 v2.0

实施基线：`codex/mimiagent-integrated`

参考：

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- 《MimiAgent 长时运行模型选型与成本优化方案》v1.0
- 2026-07-29 各 Provider 官方模型与价格文档

## 一、最终结论

当前 MimiAgent 已经有 Provider 配置目录、Session actor、后台 Task、SubAgent、Ultra Team、RunScope、Provider fallback 和 ExecutionLedger，但模型仍是全局活动配置：

- `AppConfig` 只有一个活动 `provider/defaultModel`。
- 跨 Provider `/model` 会改私有环境配置并重启 Daemon。
- Session 只能真正恢复当前活动 Provider 下的 model。
- `createSubAgentTools()` 和 `createTeamTools()` 都接收主 Run 的同一个 `model`。
- Team worker 虽然逐任务创建 Agent，但 `defaultWorker()` 仍使用 `options.model`。
- 后台 worker 只收到活动 Provider 的配置和凭据。

最终采用四层轻量结构：

```text
上层场景
Conversation / Background / Schedule / SubAgent / TeamTask / Media WorkUnit
                              │
                              ▼
WorkUnitModelResolver
场景默认 + Session 偏好 + 任务复杂度 + 硬能力要求
                              │
                              ▼
ModelGateway
Provider Registry + Adapter + credential + explicit client
                              │
                              ▼
RunModelBinding
本次 Run/WorkUnit 冻结的实际模型与选择原因
```

职责必须分开：

- 上层描述“这是什么任务、难不难、必须具备什么能力”。
- `WorkUnitModelResolver` 决定精确 `providerId + modelId`。
- `ModelGateway` 只负责按 target 创建对应 Provider Runtime，不参与业务判断。
- `RunModelBinding` 保证执行开始后不漂移。

不引入固定 `fast/balanced/strong/vision` 模型档位、不引入 Router LLM、不引入规则 DSL，也不维护大而全的模型数据库。

## 二、实施基线与不变量

### 2.1 当前实测

2026-07-29 在当前工作树实测：

```text
npm run check：通过
npm test：726/726 通过
skipped：0
```

关键代码事实：

- `src/runtime/mimi-host.ts` 已提供同 Session FIFO、跨 Session 有界并发，不重写。
- `src/runtime/pipeline/run-scope.ts` 已有不可变 RunScope，是冻结模型的正确边界。
- `src/core/team.ts` 已持久化 TeamTask、claim、lease、依赖和路径所有权。
- `src/extensions/team.ts` 已在 `defaultWorker()` 中逐 Task 创建 Agent，适合在这里注入独立模型。
- `src/extensions/subagents.ts` 当前预先用一个 model 创建三个 Agent；要支持每次委派独立选型，需要改为委派开始时创建 Agent。
- `src/runtime/bootstrap.ts` 仍使用 `setDefaultOpenAIClient()`，多 Provider 并发前必须移除运行期全局 client。

当前工作树另有未提交偏好/文档改动。实施必须在其上增量合并，不得覆盖、回退或重写无关修改。

### 2.2 必须保持

- Kernel 空闲时不调用模型。
- 同一 Session FIFO，跨 Session 有界并发。
- 主 Agent 拥有 Session 和最终回答，SubAgent/Team 不递归委派。
- Plan 保持只读，Ultra 保持最多四 worker 和 builder 路径不重叠。
- Tool call/result 协议单元不能被拆开。
- started/failed/uncertain 副作用不能因换模型、fallback 或升级自动重放。
- Security Profile、CapabilityResolver、event policy 与模型选择正交。
- Owner 临时敏感值只发送给当前冻结 target，不扩散到其他 Provider、SubAgent 或 Team。
- 不把 API key 写入 Session、Task、Trace、模型配置或工作区。

## 三、最小核心契约

### 3.1 精确模型地址

```ts
export interface ModelTarget {
  providerId: string;
  modelId: string;
}
```

不能只存裸 `modelId`，因为不同 Provider 可能存在同名模型、代理模型或不同区域实例。

### 3.2 最小模型注册

只维护影响调用正确性的字段：

```ts
export type ModelKind = 'agent' | 'image-generation';

export interface ModelRegistration {
  target: ModelTarget;
  kind: ModelKind;
  capabilities: {
    imageInput: boolean;
    imageOutput: boolean;
    toolCalling: boolean;
  };
  contextWindow?: number;
}
```

必须区分：

- `imageInput=true`：能看图；
- `imageOutput=true`：能生图；
- `toolCalling=true`：能驱动 Agent 工具循环。

价格、推荐场景、完整推理档位、延迟和成功率都不是注册必填项。

### 3.3 Provider 与 Adapter

```ts
export type ProviderTransport =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-generate-content';

export interface ProviderDefinition {
  id: string;
  label: string;
  transport: ProviderTransport;
  baseUrl?: string;
  region?: string;
  apiKeyEnv: string;
  models: ModelRegistration[];
}
```

首批实例：

```text
openai-main   -> openai-responses
deepseek-main -> openai-chat-completions
kimi-main     -> openai-chat-completions
qwen-main     -> openai-chat-completions
claude-main   -> anthropic-messages
gemini-main   -> google-generate-content
```

Adapter 负责：

- 显式创建 SDK client/model；
- 输入与 transcript 转换；
- Provider 原生推理参数；
- usage 和错误解析；
- health probe；
- Agent Runtime 或图片 Runtime 的创建。

上层只使用统一 Gateway：

```ts
interface ModelGateway {
  createAgentRuntime(target: ModelTarget, reasoning: ReasoningIntent): AgentModelRuntime;
  createImageRuntime(target: ModelTarget): ImageModelRuntime;
  inspect(target: ModelTarget): ModelRegistration;
  health(target: ModelTarget): Promise<ModelHealth>;
}
```

不得在上层出现 `if (provider === 'kimi')` 等厂商分支。

### 3.4 推理只表达通用意图

```ts
export type ReasoningIntent = 'off' | 'auto' | 'high';
```

Adapter 映射到 Provider 原生语义：

```text
DeepSeek -> thinking enabled/disabled + 原生 effort
OpenAI   -> reasoning_effort
Claude   -> extended/adaptive thinking
Gemini   -> thinking_level
Kimi     -> K3 原生 reasoning_effort
千问     -> thinking/non-thinking
```

模型不支持用户显式要求时必须报错；不能伪造统一档位或静默降级。新增同 Provider 模型通常只注册 modelId 和三项硬能力，不要求用户维护推理参数表。

## 四、上层如何选择模型

### 4.1 任务画像

```ts
export type TaskComplexity = 'simple' | 'normal' | 'hard';

export interface ModelRequirements {
  imageInput?: boolean;
  imageOutput?: boolean;
  toolCalling?: boolean;
  reasoning?: ReasoningIntent;
}

export interface WorkUnitModelProfile {
  complexity?: TaskComplexity;
  requirements?: ModelRequirements;
  modelTarget?: ModelTarget;
}
```

`complexity` 是任务属性，不是模型档位。

结构化来源：

- Host 发现当前输入真的包含图片时，确定性设置 `imageInput=true`。
- 生图/改图工具固定设置 `imageOutput=true`。
- Team Planner 在创建 TeamTask 时顺手填写复杂度和 requirements。
- SubAgent 委派工具在参数中携带复杂度和 requirements。
- 用户显式模型命令产生 `modelTarget`。

Router 不读取用户自由文本、不做关键词/正则分类，也不额外调用一个路由模型。

### 4.2 Team 复杂度由谁判断

负责拆解 Team 的主 Agent 本来就要输出任务目标、角色、依赖、路径和验收，只增加两个小字段：

```ts
interface TeamTaskInput {
  // 现有字段保持
  complexity?: TaskComplexity;
  modelRequirements?: ModelRequirements;
  modelTarget?: ModelTarget;
}
```

如果主 Agent 没填，Host 使用角色兜底：

```text
explorer / tester    -> simple
builder / researcher -> normal
architect / reviewer -> hard
```

角色只用于补缺，显式任务复杂度优先。

### 4.3 场景路由

```ts
export interface ScenarioRoute {
  target?: ModelTarget;
  candidates?: ModelTarget[];
  maxTurns?: number;
  maxOutputTokens?: number;
}

export interface ModelRoutingConfig {
  globalDefault: ModelTarget;
  scenarios: Record<string, ScenarioRoute>;
}
```

场景键保持有限、可读：

```text
conversation.default
background.default
scheduled.default
memory-maintenance.default
subagent.researcher
subagent.reviewer
subagent.architect
team.simple
team.normal
team.hard
image-understanding.default
image-generation.default
image-editing.default
```

第一版按要求设置：

```text
globalDefault      -> DeepSeek V4 Pro
team.simple        -> DeepSeek V4 Pro
team.normal        -> DeepSeek V4 Pro
team.hard          -> DeepSeek V4 Pro
全部兼容 Agent 场景 -> DeepSeek V4 Pro
```

硬能力例外：

- DeepSeek 当前不支持图片输入，所以看图任务必须选择视觉模型。
- 生图任务必须选择 `imageOutput=true` 的专用模型。
- 没有兼容模型就明确 blocked，不能回落文本模型。

后续用户可以动态设置：

```text
team.simple        -> DeepSeek V4 Flash
team.normal        -> DeepSeek V4 Pro
team.hard          -> GPT / Claude / Kimi K3
subagent.researcher -> 千问或 DeepSeek V4 Flash
image-understanding -> Gemini
image-generation   -> GPT Image / Gemini Image / Qwen Image
```

### 4.4 轻量 Resolver

唯一选择模块：

```ts
interface WorkUnitModelResolver {
  resolve(input: {
    scenario: string;
    profile?: WorkUnitModelProfile;
    sessionTarget?: ModelTarget;
    teamTarget?: ModelTarget;
    routeVersion: number;
  }): RunModelBinding;
}
```

选择顺序：

```text
1. 生成并校验硬能力要求
2. WorkUnit 显式 modelTarget
3. 本次 Team 整体 target（若提供）
4. Conversation 的 Session target
5. team.<complexity> 或 subagent.<role>
6. 对应场景默认
7. globalDefault
8. 无兼容模型则 blocked
```

规则：

- 每个候选都必须通过硬能力和 credential/health 校验。
- WorkUnit 显式 target 不兼容时直接拒绝，不猜。
- Session pin 只约束主 Conversation；不强迫生图等不兼容子 WorkUnit 继承。
- Team route snapshot 在 Team Run 开始时冻结，已开始 Team 不受后续配置修改影响。
- 每个 worker 启动前解析自己的 target，因此同一 wave 可以并行使用不同模型。

### 4.5 冻结执行绑定

```ts
export interface RunModelBinding {
  target: ModelTarget;
  kind: ModelKind;
  reasoning: ReasoningIntent;
  scenario: string;
  complexity?: TaskComplexity;
  reason:
    | 'explicit-work-unit'
    | 'team-override'
    | 'session-preference'
    | 'scenario-route'
    | 'global-default'
    | 'safe-fallback';
  routeVersion: number;
}
```

它进入不可变 RunScope/WorkUnit receipt，但不保存 credential、client 或价格表。用户修改模型只影响下一 Run 或尚未开始的新 Team。

## 五、Team 与 SubAgent 执行流程

### 5.1 Team

```text
主 Agent 调用 set_team_tasks
  -> 生成 2～6 个 TeamTask
  -> 每个 task 带 role/complexity/requirements/可选 target
  -> Team Run 冻结 routeVersion
  -> run_team claim ready tasks
  -> 每个 task 启动前调用 WorkUnitModelResolver
  -> ModelGateway 创建独立 Runtime
  -> worker Run 冻结 binding
  -> 原有最多四并发、lease、路径边界保持
```

示例：

| TeamTask | 画像 | 结果 |
|---|---|---|
| 搜索资料 | simple + tools | DeepSeek V4 Flash |
| 架构分析 | hard + reasoning=high | Claude/GPT/Kimi |
| 检查截图 | normal + imageInput | Gemini/GPT/Claude 视觉模型 |
| 生成图片 | imageOutput | 图片 Runtime |
| 最终审查 | hard | 配置的高质量 Agent 模型 |

初始路由全部仍是 DeepSeek V4 Pro；上表示意后续配置能力。

### 5.2 SubAgent

当前 SubAgent 在工具创建时预建 Agent，无法按每次委派动态选型。改造为：

```text
delegate_* 收到 input + complexity + requirements + 可选 target
  -> resolve binding
  -> Gateway 创建本次 Agent
  -> 使用现有 role tool allowlist
  -> 执行并返回 WorkUnitResult
```

不改变 SubAgent 只读角色、工具白名单、私有 Memory 隔离和禁止递归委派。

### 5.3 生图不是聊天 SubAgent

GPT Image、Gemini Image、Qwen Image 等纯图片模型通常不能运行通用 Agent 工具循环，因此：

```text
可选提示词整理 Agent WorkUnit
             ↓
image-generation WorkUnit
             ↓
图片 artifact + provider/model/requestId/usage
```

用户看到的是一个委派任务，底层按 Runtime 类型执行。纯生图模型不能伪装成 `AgentModel`。

### 5.4 失败升级

不在运行中的 worker 中途换模型。

只有以下情况可以创建新的高一级 WorkUnit：

- 当前任务在任何外部副作用前明确失败；
- reviewer 对纯读取/生成结果明确拒绝；
- 模型返回结构化 capability blocked。

第一版每个任务最多自动升级一级；started/uncertain 副作用后禁止自动升级和重放。

## 六、Provider 接入与初始模型

### 6.1 首批范围

| Provider | 首批模型 | 关键能力 |
|---|---|---|
| DeepSeek | V4 Pro、V4 Flash | 文本 Agent、工具、推理 |
| OpenAI | GPT 系列；GPT Image 单独注册 | 文本/视觉 Agent；生图 |
| Anthropic | Claude 精确模型 | 文本/视觉 Agent |
| Google | Gemini 精确模型；Gemini Image 单独注册 | 多模态理解；生图 |
| Kimi | Kimi K3 | 文本/视觉、长上下文、工具 |
| 千问 | qwen3.7-plus、qwen3.6-flash；图片模型单独注册 | 中文/视觉 Agent；生图 |

“GPT/Claude/Gemini/千问”只是模型家族，运行配置必须使用账户真实可用的精确 modelId。

### 6.2 配置文件

Owner 私有配置：`~/.mimi-agent/models.json`，可用 `MIMI_MODELS_CONFIG` 覆盖。Zod 校验、0600、加锁、原子替换，不保存 key：

```json
{
  "version": 1,
  "routeVersion": 1,
  "providers": [
    {
      "id": "deepseek-main",
      "label": "DeepSeek",
      "transport": "openai-chat-completions",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": [
        {
          "target": {
            "providerId": "deepseek-main",
            "modelId": "deepseek-v4-pro"
          },
          "kind": "agent",
          "capabilities": {
            "imageInput": false,
            "imageOutput": false,
            "toolCalling": true
          },
          "contextWindow": 1048576
        }
      ]
    }
  ],
  "routing": {
    "globalDefault": {
      "providerId": "deepseek-main",
      "modelId": "deepseek-v4-pro"
    },
    "scenarios": {}
  }
}
```

新增同 Provider 模型通常只需添加 `modelId/kind/三项能力`。已知模型可以用内置 preset 补默认值；未知能力默认 false，不能猜。

### 6.3 可选价格表

价格不进入模型注册必填字段，单独维护：

```ts
interface ModelPrice {
  target: ModelTarget;
  currency: 'CNY' | 'USD';
  billingRegion?: string;
  inputPerMillion?: number;
  cachedInputPerMillion?: number;
  outputPerMillion?: number;
  verifiedAt: string;
  sourceUrl: string;
}
```

没有价格：

- 模型照常可用；
- usage 照常记录；
- cost 显示 unknown；
- 不参与最低成本自动选择。

第一版不按价格自动选模型。后续只为实际启用模型维护可选 `PriceBook`，并以 `Cost per Successful Task` 校准。

### 6.4 官方参考

- DeepSeek：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) 与 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- OpenAI：[Models](https://developers.openai.com/api/docs/models) 与 [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)
- Anthropic：[Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- Google：[Latest Gemini models](https://ai.google.dev/gemini-api/docs/latest-model) 与 [Image generation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)
- Kimi：[Kimi API overview](https://www.kimi.com/help/kimi-api/api-overview)
- 阿里云百炼：[文本模型](https://help.aliyun.com/zh/model-studio/text-generation-model)、[视觉模型](https://help.aliyun.com/zh/model-studio/vision-model) 与 [图片模型](https://help.aliyun.com/zh/model-studio/image-model)

## 七、用户查看与调整

### 7.1 命令

```text
/models
  列出 target、Provider、三项硬能力、configured/health

/model current
  当前 Session 偏好、下一 Run route、最近实际 binding

/model inspect <providerId>/<modelId>
  查看注册能力、Provider、上下文、可选价格和健康

/model use <providerId>/<modelId>
  固定当前 Session，从下一 Run 生效

/model auto
  清除 Session 固定值

/model routes
  查看 global/scenario/team complexity 路由

/model route <scenario> <providerId>/<modelId>
/model route <scenario> auto
  修改或清除持久化场景路由

/model doctor [providerId/modelId]
  校验配置、credential、adapter、model 和非副作用 probe
```

普通模型切换不修改 `.env`、不改变全局活动 Provider、不重启 Daemon。

### 7.2 自然语言

暴露结构化控制工具：

```text
list_models
inspect_model
get_current_model
set_session_model
clear_session_model
list_model_routes
set_model_route
```

示例：

```text
“这个会话切到 Claude” -> set_session_model
“Team 简单任务以后用 DeepSeek V4 Flash” -> set_model_route(team.simple)
“复杂 Team 任务用 GPT” -> set_model_route(team.hard)
“恢复自动选择” -> clear_session_model
```

自然语言只负责调用结构化工具，禁止用关键词/正则直接改配置。路由写操作必须是 direct Owner，经过现有 authorization 和 ExecutionLedger。

### 7.3 Provider 管理

`mimi provider add/set/list/test` 负责 Provider、端点、credential 引用和 model 注册；`/model` 负责 Session 和 route。已注册模型切换无需重启；新增 adapter 的代码发布仍按正常 Daemon 升级流程。

## 八、代码改造

### 8.1 新增

| 文件 | 职责 |
|---|---|
| `src/core/model-routing.ts` | ModelTarget、Registration、Requirements、Profile、Route、Binding |
| `src/runtime/model-config.ts` | 私有配置 schema、legacy 合成、原子读写 |
| `src/runtime/model-gateway.ts` | Provider Registry、Adapter 注册、显式 Runtime 创建 |
| `src/runtime/work-unit-model-resolver.ts` | 唯一确定性模型选择 |
| `src/runtime/model-control-tools.ts` | 自然语言查看和设置 |
| `src/runtime/providers/*` | OpenAI、兼容 API、Anthropic、Gemini adapter |
| `src/runtime/media-runtime.ts` | 图片生成/编辑 WorkUnit |

不新增数据库、常驻服务、消息队列、规则引擎或 Router LLM。

### 8.2 修改

| 文件 | 改造 |
|---|---|
| `src/config.ts` | 增加 model config 路径；旧活动 Provider 仅作兼容输入 |
| `src/provider-config.ts` | 注册 Provider，不再把选择等同全局切换 |
| `src/runtime/bootstrap.ts` | 移除运行期 `setDefaultOpenAIClient()` |
| `src/runtime/model.ts` | 迁移为 Gateway/adapter 公共能力，保留兼容导出 |
| `src/runtime/components.ts` | 注入 config/gateway/resolver |
| `src/runtime/mimi-agent.ts` | Run 前解析 binding，按 target 创建 runtime/context |
| `src/runtime/pipeline/run-scope.ts` | 冻结 binding，不保存 credential |
| `src/runtime/run-service.ts` | fallback/health 使用精确 target，保持 no-replay |
| `src/core/session.ts` | 保存 `modelTarget`，兼容旧 provider/model |
| `src/runtime/control.ts` | Session/route 结构化控制，旧 switch 兼容 |
| `src/commands.ts` | 新命令语义 |
| `src/chat-terminal.ts` | 普通模型切换不 persist+restart |
| `src/core/team.ts` | TeamTask 增加 complexity/requirements/target，旧记录兼容 |
| `src/extensions/team.ts` | `options.model` 改为逐 task resolver/gateway |
| `src/extensions/subagents.ts` | 每次委派解析并创建 Agent |
| `src/daemon/task-supervisor.ts` | fork 前解析，只传选中 credential |
| `src/daemon/worker-protocol.ts` | 严格校验 Provider target/binding |
| `src/daemon/task-worker-entry.ts` | 从 binding 创建显式 runtime |
| `src/daemon/store.ts` | usage 增加 providerId/modelId/scenario/reason |
| `docs/ARCHITECTURE.md`、`MIMI.md`、`README.md`、`CHANGELOG.md` | 同步用户和架构契约 |

不得重写 Host、Team store、Goal/Plan、Event/Task/Outbox、Security 或 ExecutionLedger。

## 九、分阶段实施与验收

### 阶段 0：锁定现状

- 补全当前跨 Provider 重启、Session 非活动 Provider 恢复失败、SubAgent/Team 同模型继承的 characterization tests。
- 建两个本地 fake Provider endpoint，记录端点、model 和 credential 指纹。
- 保持基线测试数不下降、skipped=0。

### 阶段 1：Gateway 与多 Provider 并发

- 实现 model config、显式 client、Gateway 和 adapters。
- 配置缺失时从旧环境变量合成 legacy target，行为不变。
- 同进程并发访问两个 compatible Provider 和一个 Responses Provider，端点/key/model 不串。
- credential 缺失、重复 target、未知能力、非法 adapter 全部失败关闭。

### 阶段 2：Session 动态模型

- Session 持久化 `ModelTarget`。
- `/model use/auto` 与自然语言工具只改当前 Session。
- Run 开始冻结 binding；运行中修改只影响下一 Run。
- Session A/B 并发使用不同 Provider，Daemon PID 不变，重启后各自恢复。
- 跨 Provider transcript 保持完整 tool call/result。

### 阶段 3：SubAgent、Team 与后台

- TeamTask 增加复杂度、硬能力和 target。
- `defaultWorker()` 前逐 Task resolve；同一 wave 可命中不同 fake Provider。
- SubAgent 每次委派 resolve，角色工具集和只读边界不变。
- 后台 worker 只获得选中 target 的 credential。
- Team 路由版本冻结；配置修改不影响已开始 Team。

### 阶段 4：媒体与观测

- 图片输入与图片输出硬能力分别测试。
- 生图只进入 Media Runtime；无图片模型时 blocked。
- 每次 Run/WorkUnit 记录 target、scenario、复杂度、reason、usage。
- 可选 PriceBook 未配置时成本为 unknown，不影响执行。
- 后续经真实任务灰度后再把 `team.simple/background` 改为 Flash。

## 十、测试矩阵

必须新增：

- model config schema、权限、原子写、legacy 合成；
- Gateway 显式 client 与 adapter 隔离；
- Resolver 优先级、三种复杂度和硬能力过滤；
- Session A/B 不同 Provider 并发；
- Team wave 不同 task 命中不同 target；
- SubAgent 同角色不同委派可选择不同 target；
- image input 与 image output 反向测试；
- Run/Team route 冻结；
- worker credential 最小化和 secret 泄漏检查；
- Session/Team 旧 JSON 兼容；
- runtime control authorization/ledger；
- stream/tool/side-effect 前后 fallback/no-replay。

最小命令：

```bash
npm run check
node --import tsx --test tests/model-config.test.ts
node --import tsx --test tests/model-gateway.test.ts
node --import tsx --test tests/model-router.test.ts
node --import tsx --test tests/subagents.test.ts
node --import tsx --test tests/team.test.ts
node --import tsx --test tests/task-worker-protocol.test.ts
```

完成门：

```bash
npm run check:repo
npm run check
npm test
npm run build
npm run test:package
git diff --check
```

要求：

- 全量测试不少于当前 726，fail=0，skipped=0。
- 不得 `.skip/.todo`、删除测试、放宽已有断言、降低 coverage、mock 掉被测路由或使用 `|| true`。
- 真实 Provider canary 只在显式凭据和预算下执行，不作为单元测试依赖。

## 十一、迁移与回滚

### 11.1 配置

没有 `models.json` 时：

```text
OPENAI_*        -> openai-main
DEEPSEEK_*      -> deepseek-main
MIMI_PROVIDER_* -> legacy-compatible
MIMI_BACKUP_*   -> legacy safe fallback
```

配置损坏时隔离并失败关闭，不能生成空文件覆盖。

### 11.2 Session 与 Team

- 旧 `preferences.provider/model` 能精确匹配时迁移为 `ModelTarget`。
- 同名 model 属于多个 Provider 时要求用户选择，不猜。
- Provider 不存在时保留旧值并显示 warning。
- 旧 TeamTask 没有 complexity 时按 role 补默认；只有下一次合法 mutation 才写新格式。

### 11.3 回滚

- 新配置缺失时退回 legacy env 合成。
- 旧 Session/Team schema 保持可读。
- 新 usage/binding 字段可选，旧 receipt 可读。
- 回滚不得删除 Session、Task、ExecutionLedger、artifact 或 credential。

## 十二、最终完成标准

功能完成：

1. 一个 Daemon 内 Session A/B 可并发使用不同 Provider，普通选择不重启。
2. 一个 Team wave 内不同复杂度/能力任务可冻结不同 ModelTarget。
3. SubAgent、后台 worker 和媒体 WorkUnit 均通过同一 Resolver + Gateway，且不越过原权限。
4. 用户能通过命令和自然语言查看、固定、清除和修改路由。
5. 默认兼容场景全部为 DeepSeek V4 Pro；不兼容的视觉/生图任务只选满足硬能力的模型。

工程完成：

1. 上层无 Provider 专用分支，Adapter/Gateway 与选择逻辑分离。
2. 没有新增 Router LLM、模型档位、规则 DSL 或必填价格数据库。
3. 726 测试基线不下降，skipped=0，完成门全部通过。
4. API key 不进入模型配置、Session、Task、Trace、IPC 日志或测试 fixture。
5. 无副作用重放、Session FIFO、Team 并发/路径边界和 Run ownership 保持。

## 十三、2026-07-30 实施后 Review 与修正门槛

对提交 `310156f`、`606c353`、运行构建 `0.12.0+8ef2c7b69eab` 的只读 Review
确认：精确 `ModelTarget`、Gateway 显式 client、Session 独立固定、Team/SubAgent
逐任务选型、后台 credential 最小化已经成立，但以下偏差未修复前不能按本方案最终验收：

1. `MediaRuntime` 只有测试直接调用，未接入 MimiAgent 工具或结构化委派入口；真实生图任务无法进入 Media WorkUnit。
2. Anthropic/Google 原生消息转换只保留文本，注册为 `imageInput=true` 时仍会丢弃图片 block。
3. `/model route` 只刷新发起命令的 Session actor；其他已缓存 actor 持有旧 Resolver 和 routeVersion。
4. 上层仍以 legacy `config.provider` 决定 Hosted Tools、历史输入归一化、RunScope 和状态展示，没有完全改用本轮精确 target/transport。
5. Claude `reasoning=high` 在未指定输出上限时形成 `max_tokens=4096`、`budget_tokens=8192`，且没有按当前模型兼容 manual/adaptive thinking。
6. `mimi provider` 仍只有会重启的 legacy `set`，缺少 registry 的 `add/set/list/test`；基础指令仍引导旧 `switch_provider`，自然语言控制没有统一到 `model_control`。
7. `ModelRegistration.contextWindow` 未参与 Runtime Profile；`ScenarioRoute.maxTurns/maxOutputTokens` 也未进入冻结 binding 和请求预算。
8. README 仍声称跨 Provider `/model` 会重启，与当前 Session target 语义矛盾。

Review 实测：`npm run check` 通过；模型聚焦测试 `53/53`；`npm run build`、
`npm run test:package`、`git diff --check` 通过。全量首轮 `753/755`，两个既有 CUA
启停/恢复用例因一次性环境争用失败，原样聚焦复跑 `2/2` 通过；不得把首轮写成
`755/755`。当前私有 registry 只注册
`friday/deepseek-v4-pro`、`deepseek/deepseek-v4-pro`，没有 V4 Flash、GPT、
Claude、Gemini、Kimi、千问或 `imageOutput` 模型，因此真实运行态尚不能宣称这些
模型和生图能力已经可用。

修正完成至少需要新增并通过：

- 产品入口级 Media WorkUnit 生图/无兼容模型 blocked 测试；
- Claude/Gemini 图片 block 原生请求反向测试；
- 两个已缓存 Session actor 修改 route 后下一 Run 同步新 routeVersion 的测试；
- legacy 启动 Provider 与实际 target 不同时，工具面、历史归一化、状态和 Trace
  全部以精确 target/transport 为准的测试；
- Claude 高推理参数兼容与预算约束测试；
- Provider registry 管理命令、自然语言 `model_control` 和 `contextWindow`/场景预算
  真正生效的测试；
- 最终不少于 `755` 个测试、fail/skipped/todo 均为 0，并完成 check、build、
  package smoke、diff check；真实 Provider 与 Daemon 验收必须使用显式预算和凭据，
  不得用 fake endpoint 冒充。
