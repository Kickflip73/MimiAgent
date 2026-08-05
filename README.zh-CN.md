<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# MimiAgent

> 一个轻量、本地优先的个人 AI Agent：可以长期在线、延续上下文，并通过终端或可靠的后台服务完成真实工作。

[![CI](https://github.com/Kickflip73/MimiAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Kickflip73/MimiAgent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MimiAgent 使用 TypeScript 和 OpenAI Agents SDK 构建。交互式 CLI 与常驻 Daemon 共享同一个 Agent Host、Session、Memory、工具、Skills、MCP 集成和执行控制。它面向单个可信本机 owner，不是多租户工作流平台。

## 为什么是 MimiAgent

- **一个 Agent，两种入口。** 既可以在终端持续对话，也可以把工作交给同一个可靠后台运行时。
- **本地优先的状态。** Session、Plan、Memory、Trace 和任务状态默认保存在本机。
- **退出终端后仍可继续。** 长任务会先持久化，再由有界子进程监督执行，并在完成后主动返回结果。
- **按任务选择模型。** 对话、后台任务、SubAgent、Team Task 和媒体任务可以路由到能力匹配的模型。
- **扩展能力不膨胀内核。** 通过 Agent Skills、MCP 和隔离 Connector 进程扩展能力。
- **明确的安全边界。** Mode、Security Profile、事件来源、工具范围和执行账本共同限制可执行能力与重试行为。

## 系统如何协作

```text
CLI / 本机事件 / 定时任务 / Connectors
                    |
                    v
            MimiAgent 常驻 Daemon
        +---------------------------+
        | Session actors            |  同一 Session 严格 FIFO
        | Background task workers   |  不同 Session 有界并行
        | Inbox / Outbox / leases   |  崩溃恢复与投递重试
        +---------------------------+
                    |
                    v
        runtime -> core + extensions + tools
```

主 Agent 始终拥有用户 Session 和最终回答。SubAgent 只允许一层有界委派；Ultra Team 最多运行四个 worker，并要求显式依赖和互不重叠的写路径。

运行时和状态不变量详见[架构设计](./docs/ARCHITECTURE.md)。

## 快速开始

### 环境要求

- Node.js 22.19.0 或更高版本
- npm 10.9.2（仓库固定版本）
- 至少一个模型 Provider 的 API Key
- 只有可选的桌面、Mail、Messages、Calendar、Notes、Contacts、Shortcuts、屏幕和语音 Connector 依赖 macOS

### 从源码安装

```bash
git clone https://github.com/Kickflip73/MimiAgent.git
cd MimiAgent
npm install
npm install -g .
mkdir -p ~/.mimi-agent
cp .env.example ~/.mimi-agent/.env
```

在 `~/.mimi-agent/.env` 中配置一个 Provider：

```dotenv
MIMI_CONFIG_VERSION=4
MIMI_MODEL_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-id
```

检查安装并开始对话：

```bash
mimi daemon doctor
mimi
```

Daemon 会在需要时自动启动。也可以直接执行一次任务：

```bash
mimi "检查当前仓库并概括它的架构"
```

DeepSeek、OpenAI-compatible、Daemon 运维和排障说明见[快速入门指南](./docs/zh-CN/GETTING_STARTED.md)。

## 模式与安全

最终可用工具由运行模式、启动时的 Security Profile、Work Unit 角色、Connector 就绪状态和事件策略共同决定。

| 控制项 | 用途 |
| --- | --- |
| General | 在当前安全档位内执行普通对话和任务。 |
| Plan | 只读分析与规划，工具选择会强制执行边界。 |
| Ultra | 使用显式依赖和路径所有权进行有界 Team 执行。 |
| Safe | 只读本机操作。 |
| Workstation | 允许工作区写入和沙箱 Shell，不允许受信 MCP、Computer Use、Connector 外部事务或通用网络写入。 |
| Full Owner | 在当前操作系统账号权限下开放完整 owner 能力。 |

> [!IMPORTANT]
> Full Owner 可以执行真实的本机和外部操作。处理陌生仓库时使用 Safe 或 Workstation；启用第三方 Skill、MCP Server 前先审查；不要把凭证放进工作区。

启用无人值守执行或外部 Connector 前，请先阅读[安全策略](./SECURITY.zh-CN.md)。

## 扩展 MimiAgent

| 扩展方式 | 适用场景 | 入口 |
| --- | --- | --- |
| Agent Skills | 可复用的指令、脚本和配套资源 | `skills/<name>/SKILL.md` |
| MCP | 可信 MCP Server 暴露的外部工具和资源 | `mcp.json` |
| Connectors | 隔离进程中的可靠事件来源和外部操作 | `mimi.connectors.example.json` |
| 公共 Package API | 在 TypeScript 中嵌入 Host 或编排能力 | `mimi-agent`、`mimi-agent/orchestration` |

内置工具面有意保持克制。特定领域或低频能力通常应实现为 Skill、MCP 集成或 Connector。

## 文档

| 从这里开始 | English | 简体中文 |
| --- | --- | --- |
| 文档总览 | [Open](./docs/README.md) | [打开](./docs/README.zh-CN.md) |
| 快速入门 | [Guide](./docs/GETTING_STARTED.md) | [指南](./docs/zh-CN/GETTING_STARTED.md) |
| 配置参考 | [Reference](./docs/CONFIGURATION.md) | [参考](./docs/zh-CN/CONFIGURATION.md) |
| CLI 与 Daemon | [Reference](./docs/CLI.md) | [参考](./docs/zh-CN/CLI.md) |
| 架构 | [Overview](./docs/ARCHITECTURE.en.md) | [详细设计](./docs/ARCHITECTURE.md) |
| 贡献指南 | [Guide](./CONTRIBUTING.md) | [指南](./CONTRIBUTING.zh-CN.md) |
| 安全策略 | [Policy](./SECURITY.md) | [策略](./SECURITY.zh-CN.md) |

更多设计参考、运维说明、评测和兼容契约已经分类收录在[中文文档索引](./docs/README.zh-CN.md)中。

## 开发

```bash
npm run check
npm test
npm run build
```

使用 `npm run ci` 运行完整的仓库规范、覆盖率、构建和打包校验。单元测试不需要 API Key，也不会访问真实用户状态；真实 Provider 评测需要显式选择运行。

提交 Pull Request 前，请阅读[贡献指南](./CONTRIBUTING.zh-CN.md)、[行为准则](./CODE_OF_CONDUCT.zh-CN.md)和仓库级 `AGENTS.md` 开发约定。

## 项目状态

MimiAgent 正在积极开发。公共入口遵循语义化版本规则，但 1.0 之前运行行为和扩展契约仍可能演进。发布内容见[更新日志](./CHANGELOG.md)。

## License

MimiAgent 使用 [MIT License](./LICENSE)。
