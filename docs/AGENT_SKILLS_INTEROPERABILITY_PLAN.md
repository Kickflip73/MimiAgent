# Agent Skills 互操作与会话激活改造计划

状态：已实施并通过验收
基线：`codex/mimi-agent-hardening`，MimiAgent `0.12.0`，2026-07-27
依据：[Agent Skills 规范](https://agentskills.io/specification)与[客户端实现指南](https://agentskills.io/client-implementation/adding-skills-support)

## 1. 目标

把 MimiAgent 从“能读取单个工作区 `skills/` 的 Agent Skills 客户端”补全为可跨客户端复用、可显式激活、会话内稳定且不会扩大权限的实现：

1. 同时发现内置、配置目录、项目级和用户级 Agent Skills。
2. 对同名 Skill 使用确定、可解释的优先级，保留冲突诊断。
3. owner 可在消息开头用 `$skill-name` 显式激活一个或多个 Skill；所有入口行为一致。
4. 同一 Session 内激活幂等，Skill 变更或来源切换不被误判为重复。
5. 激活内容不依赖旧工具结果；上下文压缩、归档、重启后仍以完整受保护指令进入模型。
6. 目录披露、显式激活、模型激活、资源读取和恢复注入共用同一能力过滤，Skill 永远不能扩大当前 Run 权限。

完成后的关键性质：

- 标准位置安装的 Skill 无需复制到仓库 `skills/`。
- MimiAgent 发布包内置 Skill 不依赖当前工作区，并可被项目或用户同名 Skill 覆盖。
- 同名 Skill 的实际胜出来源可以从 `/skills` 和 diagnostics 看见。
- `$code-review 检查这次改动` 在 CLI、Daemon owner command 和可信 owner Connector 中语义相同。
- 一份 Skill 在一个 Session 中只保留一个激活记录；`/compact` 与自动 collapse 不会令其静默失效。
- 受限 Run 缺少 `required-tools` 时不披露、不激活、不读取资源，也不恢复旧激活内容。

## 2. 不做什么

- 不新增依赖，不改 Agent Skills 文件格式，不把 MimiAgent 的 `required-tools` 宣称为开放标准。
- 不让 `allowed-tools` 提升权限。该实验字段只保留为元数据；若以后支持，也只能和当前工具集取交集。
- 不递归扫描整个仓库，不自动下载、执行或信任第三方 Skill。
- 不把 Skill 正文写成假的 user/assistant 历史，不新建第二套会话或工作流系统。
- 不在本次顺手放宽 YAML 校验、重构 MCP/Memory/Goal 或改变 Plan 只读契约。

## 3. 当前基线

实测代码：

- `src/extensions/skills.ts` 只扫描一个根目录的直接子目录，最多 200 个，严格解析 `SKILL.md`。
- `src/config.ts` 默认把 `skillsRoot` 设为 `<workspace>/skills`；`MIMI_SKILLS_DIR`/`AGENT_SKILLS_DIR` 可替换它。
- `src/runtime/mimi-agent.ts` 在最终工具集确定后生成 catalog，`required-tools` 已能 fail closed。
- `use_skill` 返回完整文件，但未记录 Session 激活状态；`read_skill_resource` 也未要求 Skill 已激活。
- `src/core/context.ts` 会压缩旧 `function_call_result` 并按轮裁剪，未保护 `use_skill` 输出。
- `/skills` 仅支持 list/reload；以 `$` 开头的普通输入目前直接交给模型。

2026-07-27 已运行：

```bash
npm run check
node --import tsx --test --test-name-pattern='skill|Skill|context|compact' tests/core.test.ts tests/config.test.ts tests/commands.test.ts
npm test
```

结果分别为通过、17/17 通过、完整测试通过。实施后不得降低既有测试数、增加 skip/todo 或削弱断言。

## 4. 已拍板的行为

### 4.1 发现来源与优先级

`SkillLoader` 接收有序 `SkillSource[]`，优先级从高到低：

1. `configured`：现有 `config.skillsRoot`，保留显式环境变量的最高控制权。
2. `project-native`：`<workspace>/skills`。
3. `project-shared`：`<workspace>/.agents/skills`。
4. `user-native`：`~/.mimi-agent/skills`。
5. `user-shared`：`~/.agents/skills`。
6. `builtin`：MimiAgent 安装包/runtime root 下的 `skills/`，只接纳 `skills/manifest.json` 中 `published: true` 的条目。

`builtin` 根目录从 MimiAgent 自身模块位置解析，不能由当前工作区或 workspace switch 改写；manifest 缺失、损坏或条目未发布时 fail closed 并产生 diagnostics，不能把实验 Skill 当成产品内置能力。

相同绝对/真实目录的文件内容只读取一次；若开发仓库的 project-native 与 builtin 指向同一文件，按高优先级来源归属且不产生无意义 shadow warning。每个来源只看直接子目录中的 `SKILL.md`；目录按名称排序，来源按上表排序。项目级始终覆盖用户级，用户级覆盖 builtin，Mimi 原生位置覆盖同作用域共享位置。

无效的高优先级候选不遮蔽有效的低优先级候选。多个有效候选同名时只注册最高优先级项，并记录结构化 `shadowed` 诊断，包含 winner、loser、sourceId 和绝对路径。总有效 Skill 仍限制 200 个，总正文仍限制 10MB；达到边界必须诊断，不能静默漏扫。

`MIMI_SKILLS_DIR` 保持兼容但从“唯一根目录”变为“最高优先级额外来源”。README 和 `/skills` 必须明确这一变化。

建议数据结构：

```ts
interface SkillSource {
  id: 'configured' | 'project-native' | 'project-shared' | 'user-native' | 'user-shared' | 'builtin';
  scope: 'configured' | 'project' | 'user' | 'builtin';
  root: string;
  precedence: number;
  manifest?: string;
}

interface Skill {
  // 保留现有字段
  source: SkillSource;
  contentHash: string;
}
```

### 4.2 显式 `$skill` 激活

在 `MimiAgent.stream()` 的统一 Run 边界解析，不放在终端 UI 中，因此 CLI、Daemon 和 Connector 共享行为。

语法：

- 只识别 owner-trusted 输入开头、以空白分隔的 `$<标准 skill name>`。
- 支持多个前缀：`$research $writing-partner 调研并成文`，按首次出现顺序去重。
- `\\$name` 和正文中间的 `$name` 保持普通文本。
- 未安装、被冲突遮蔽、当前 Run 不可用或无本地读取权时，在模型运行前给出明确错误；不得退化为“让模型猜”。
- 外部事件、ambient/webhook 和非 owner 内容中的 `$name` 永远只是数据，不能触发激活。
- 原始 user input 原样进入 Transcript；解析结果作为可信宿主运行状态传递，不改写用户证据。

新增纯函数模块 `src/extensions/skill-invocation.ts`，解析器不得读取文件或改变状态，便于独立测试。显式激活仍经过和 `use_skill` 相同的 registry/availability API。

### 4.3 Session 激活状态与去重

在现有 `FileSession` JSON 中增加可选、向后兼容的 `activeSkills`，不另建 Store：

```ts
interface ActivatedSkill {
  name: string;
  sourceId: SkillSource['id'];
  file: string;        // canonical path
  contentHash: string; // SHA-256
  activatedAt: string;
  updatedAt: string;
}
```

增加原子方法：`getActiveSkills()`、`activateSkill(record, expectedRunId?)`、`deactivateSkill(name)`。Run 内写入带 `expectedRunId`，防止旧 Run 改写当前 Session；`clearSession()` 同时清空激活状态。旧 Session 无该字段时按空数组读取。

幂等键是 `name + canonical file + contentHash`：

- 完全相同：返回 `already_active`，不重复正文、不增加记录。
- 同一路径正文改变：更新 hash 和时间，只保留一条；下一轮注入新正文。
- 同名 winner 路径改变：旧激活标记 stale，本轮不自动换成另一来源；只有新的 `$name` 或 `use_skill(name)` 才重新绑定，防止来源替换后静默注入。
- `reload_skills` 只重建 registry，不直接改 Session；随后 list/Run 给出 stale 诊断。

`use_skill` 首次成功时持久化激活；重复调用返回结构化状态而不是再次返回正文。增加 `/skills active` 与 `/skills deactivate <name>`，否则持久激活无法安全退出。停用只能作用于当前 Session。

### 4.4 防压缩丢失

激活正文不再依赖历史中的 `use_skill` 结果。每轮从 Session 读取 active records，经当前 registry 和能力过滤重新解析后，作为新的 `active-skills` 指令区注入：

```xml
<active_skills>
  <skill_content name="..." source="..." content_hash="...">
    ...完整 SKILL.md...
    Skill directory: /absolute/root
    Relative paths resolve from this directory.
  </skill_content>
</active_skills>
```

包装文字必须声明：Skill 低于 system/host/user 权威，不能扩大权限，外部内容仍是不可信数据。

`ContextParts`/manifest 增加 `activeSkills` 与 `active-skills` section。`base-instructions` 和 `active-skills` 标为 required：必须完整放入，不能走 `fitTokens()` 截断；放不下时在激活预检或建请求阶段明确失败，并提示停用/拆分 Skill。Memory、archive、catalog 等可让出预算。不得把“截断后的 Skill”标成已激活。

模型首次调用 `use_skill` 时当前工具调用单元仍返回完整正文；成功记录保证下一轮和重启后从 protected section 恢复。`/compact` 只处理 Transcript/Archive，不触碰 `activeSkills`。

### 4.5 能力安全过滤

把现有 `missingRequiredTools()` 提升为唯一的 `evaluateAvailability(skill, runAccess)`：

```ts
interface SkillAvailability {
  available: boolean;
  reasons: Array<'local-read-denied' | 'missing-required-tool' | 'stale-binding' | 'instruction-budget'>;
  missingTools: string[];
}
```

以下入口必须调用同一 evaluator：

- 初始 catalog；
- `$skill`；
- `use_skill`；
- protected active-skills 恢复；
- `read_skill_resource`；
- `list_skills`/`/skills` 的状态展示。

规则：

- 以本轮最终注册工具名为准，不以安全档位、模型能力或磁盘上存在脚本为准。
- 先应用 source policy/`canReadLocal`，再检查 `required-tools`，最后检查激活绑定和指令预算。
- `read_skill_resource` 必须要求 Skill 在当前 Session 已激活、绑定未 stale、当前 Run 仍 available，并继续执行现有绝对路径、目录逃逸、symlink 和 256KB 限制。
- Run 切到 Plan 或受限外部来源后，旧激活记录可以保留，但本轮不注入、不读资源；权限恢复后重新可用。
- `allowed-tools` 不得注册新工具、跳过 side-effect authorization 或覆盖 ToolPolicy。

## 5. 实施顺序与文件边界

### 阶段 A：多来源 registry

修改 `src/config.ts`、`src/runtime/components.ts`、`src/extensions/skills.ts`。先完成六类来源解析、内置 manifest allowlist、真实路径去重、确定排序、冲突诊断与来源展示。保持 `SkillLoader(string)` 兼容测试构造，生产使用 `SkillSource[]`。

测试放入 `tests/skills.test.ts` 和 `tests/config.test.ts`：六类来源发现、内置 Skill 不随 workspace switch、只加载 published manifest 条目、manifest 损坏 fail closed、每级冲突、无效 winner 回退、同文件去重、稳定排序、200/10MB 边界。用 `tests/package-smoke.mjs` 证明发布包实际携带 manifest 和全部 published Skill。

### 阶段 B：显式激活和持久去重

新增 `src/extensions/skill-invocation.ts`；修改 `src/core/session.ts`、`src/runtime/pipeline/state-loader.ts`、`src/runtime/mimi-agent.ts`、`src/commands.ts`。先落 Session schema/API，再接 `$skill`、`use_skill` 和 active/deactivate 命令。

测试覆盖：owner/非 owner、开头/正文/转义、多个/重复/未知 Skill、重启恢复、并发 Session、stale runId、clear/deactivate、同文件更新和 winner 换源。

### 阶段 C：受保护上下文和统一过滤

修改 `src/core/context.ts`、`src/runtime/pipeline/context-assembler.ts`、`src/runtime/mimi-agent.ts`、`src/extensions/skills.ts`。先建立 evaluator，再让所有入口切换过去；最后加入 required active-skills section 和预算预检。

测试必须真实构造超过 history limit 的多轮 Transcript，并分别触发自动 collapse 与手动 full compact，断言：

- 原始 Transcript 未增加伪造消息；
- active-skills 正文完整、`truncated=false`；
- `use_skill` 旧结果可被裁剪但下一轮仍有完整 protected section；
- 缺工具、Plan/外部来源、stale binding 时正文不存在且错误原因准确；
- 资源未激活或失去能力时拒绝读取。

### 阶段 D：文档和回归

修改 `README.md`、`docs/ARCHITECTURE.md`、`CHANGELOG.md`，说明搜索路径、优先级、`$skill`、Session 生命周期、停用方式、`required-tools` 扩展及 `allowed-tools` 非提权语义。不得改 release 版本。

允许写入范围仅限以上文件、对应测试（含必要时的 `tests/package-smoke.mjs`）、本计划文档，以及实施期间用于断点续跑的根目录 `PROGRESS.md`、`BLOCKED.md`；其他路径只读。不得编辑 `dist/`、锁文件、依赖、已有 Skill 内容、`skills/manifest.json` 或与本计划无关的当前工作树改动。

## 6. 验收矩阵

新增测试名应直接表达以下契约：

1. `project skills override user skills and report every shadowed source`
2. `builtin skills are package rooted manifest allowlisted and lowest precedence`
3. `invalid higher precedence candidate does not hide a valid fallback`
4. `owner leading dollar mentions activate once across every host surface`
5. `untrusted event dollar mentions remain inert text`
6. `activation survives restart collapse and full compact without fake history`
7. `repeated activation is idempotent and changed source requires reactivation`
8. `every skill entry point fails closed against the final run tool set`
9. `resources require a currently available active binding`
10. `active skill instructions are never silently truncated`

反向验证至少包括：

- 临时交换项目/用户优先级，冲突测试必须红；还原后绿。
- 临时删除 active-skills required 标记，压缩测试必须红；还原后绿。
- 临时绕过 resource availability，受限资源测试必须红；还原后绿。

最终运行：

```bash
npm run check
node --import tsx --test tests/skills.test.ts tests/config.test.ts tests/commands.test.ts tests/core.test.ts
npm test
npm run build
npm run test:package
git diff --check
```

全部退出码为 0；无 skip/todo；`git diff --stat` 只出现白名单文件。测试失败不得使用 `.skip`、放宽断言、mock 被测 registry/evaluator、删除测试、修改阈值或 `|| true` 绕过。

## 7. 迁移、风险与止损

- Session schema 只增加 optional 字段，不做破坏性迁移；旧文件读取后第一次真实激活时自然写入。
- 路径必须保存 canonical form；缺失文件、symlink 换向或 source winner 改变都进入 stale，不自动落到另一同名 Skill。
- 多来源会增加启动 IO；只扫描固定五个根的直接子目录并保留现有限额，不做递归。
- protected instructions 会挤压其他动态上下文；以“权限与 Skill 完整性 > 记忆/catalog 丰富度 > 历史长度”为取舍顺序。
- 同一验收连续失败 3 次，停止该路线，把命令、输出和下一候选方案写入 `BLOCKED.md`；不得用放宽安全边界换绿。

实施时维护仓库根目录 `PROGRESS.md` 与 `BLOCKED.md`；中断后先读 `PROGRESS.md`，不得重做已完成阶段。交付前把有效决策归并进本文和架构文档并删除 `PROGRESS.md`；`BLOCKED.md` 随交付保留，空文件也写“无”，验收完成后再由维护者删除。

## 8. 完成条件

同时满足才算完成：

1. 六类来源（含 manifest allowlisted builtin）、确定冲突、owner `$skill`、Session 去重/停用、重启与两种压缩保留、统一能力过滤全部有正向和反向自动化证据。
2. `npm run check && npm test && npm run build && npm run test:package`、聚焦测试和 `git diff --check` 全绿，既有测试不减少、skip/todo 为 0、无白名单外改动。

最终报告必须列出行为变化、迁移影响、实际命令输出、红→绿反向证据、未解决风险；只说“已支持”不算完成。
