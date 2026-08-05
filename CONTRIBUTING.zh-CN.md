<p align="center">
  <a href="./CONTRIBUTING.md">English</a> | <strong>简体中文</strong>
</p>

# 参与贡献

感谢你帮助改进 MimiAgent。贡献应让本地 Agent 更实用、可靠、易懂或安全，同时保留轻量架构和明确权限边界。

参与项目即表示你同意遵守[行为准则](./CODE_OF_CONDUCT.zh-CN.md)。

## 开始之前

- 先搜索已有 Issue 和 Pull Request，避免重复。
- 聚焦的 Bug 修复或文档纠错可以直接提交 Pull Request。
- 新增内置工具、持久状态格式、公共 API、大型依赖或架构变更前，请先创建 Issue，说明使用场景和最小兼容设计。
- 不要在公开 Issue 披露安全漏洞，请遵循[安全策略](./SECURITY.zh-CN.md)。

## 开发环境

需要：

- Node.js 22.19.0 或更高版本
- npm 10 或更高版本
- Git

```bash
git clone https://github.com/Kickflip73/MimiAgent.git
cd MimiAgent
npm install
npm link
mimi --help
```

单元测试、类型检查、构建、打包检查和本地检索评测都不需要 API Key。可选的真实 Provider 凭证只能放在 `~/.mimi-agent/.env` 或其他被忽略的私有环境文件中。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `src/runtime/` | 组合、执行生命周期、Provider、Mode、权限和 Runtime Effect |
| `src/core/` | 持久 Agent 语义与校验后的状态 |
| `src/extensions/` | 可选 Skill、MCP、检索、SubAgent 和 Team 能力 |
| `src/daemon/` | 可靠 Event、Lease、Schedule、IPC、Connector 和通知 |
| `src/tools.ts` | 小而通用的高频 Host 工具 |
| `tests/` | 确定性的 Node Test Runner 测试 |
| `docs/` | 用户指南、架构、运维、契约和设计记录 |

修改 Runtime 或持久状态行为前，请阅读 [AGENTS.md](./AGENTS.md) 和[架构契约](./docs/ARCHITECTURE.md)。

## 工作约定

1. 阅读相关源码、附近测试和当前文档。
2. 定义解决问题所需的最小可观察结果。
3. 行为变化应新增或更新聚焦测试。
4. 保持 Patch 聚焦，不格式化或重构无关代码。
5. 先运行最小相关检查，再按风险扩大验证范围。
6. 最终检查 Diff 中是否存在生成文件、凭证、过期文档和无关变更。

TypeScript 使用 ESM、Strict Mode、NodeNext、ES2022、两空格缩进、分号和单引号。相对 Import 带 `.js` 扩展名；Node 内置模块使用 `node:`，纯类型依赖使用 `import type`。

## 架构规则

- CLI 与 Daemon 共享一个主 Agent Host；用户 Session 只有一个 owner。
- SubAgent 有边界、只允许一层，并且不拥有最终回答。
- Plan 只读；Ultra 最多四个 Worker，必须显式依赖并使用不重叠写路径。
- 除非协议能力要求并有文档说明，否则保持不同 Provider 的行为一致。
- 裁剪历史时不得拆开 `function_call` 与对应的 `function_call_result`。
- 不把临时摘要或检索结果持久化为对话历史。
- 活跃 Run 的写入必须受不可变 Session 和 Run 所有权约束。
- 持久 JSON 使用已校验的原子 Store，不新增临时 Read-Modify-Write 状态路径。
- 不静默重放结果不确定的 Shell、文件、MCP、Connector 或外部事务。
- 新增内置工具前，先考虑 Skill、MCP、Connector 或已有工具组合。

## 验证

按风险选择检查：

| 变更 | 必需检查 |
| --- | --- |
| 纯文档 | 校验链接、示例和 `npm run check:repo` |
| 小型实现 | `npm run check` 和聚焦测试 |
| Runtime、Core 或 Daemon 行为 | `npm run check && npm test && npm run build` |
| 检索 | 增加 `npm run eval` |
| 打包、Export、CLI 入口或发布文件 | 增加 `npm run test:package` |
| 发布就绪 | 条件允许时运行 `npm run ci` |

`npm run eval:agent` 等真实 Provider 检查和 macOS UI 测试都需要显式选择。普通测试不能依赖 API Key、公网或用户真实的 `~/.mimi-agent` 数据。

## 文档

- 根 README 保持简短；安装、配置、CLI、架构和安全细节进入专门文档。
- 用户可见行为变化时同步更新英文和简体中文版本。
- 两种语言中的命令、路径、环境变量和标识必须一致。
- 使用[文档索引](./docs/README.zh-CN.md)对新增文档分类。
- 发布相关行为更新 `CHANGELOG.md`。

## Commit 与 Pull Request

- 从 `main` 创建聚焦分支。
- 使用 Conventional Commits，例如 `fix(session): preserve tool result pairing`。
- 保持 Commit 易于审查，不提交生成的 `dist/`。
- 在 Pull Request 中说明动机、行为变化、实际验证和文档影响。
- 存在 Issue 时建立关联。
- Bug 修复应尽量包含回归测试。

Pull Request 不能包含 `.env`、API Key、Token、个人数据、`.mimi-agent/`、Session、Trace、本地数据库、截图、录屏或无关工作区资产。
