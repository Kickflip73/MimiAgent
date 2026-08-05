<p align="center">
  <a href="../CONFIGURATION.md">English</a> | <strong>简体中文</strong>
</p>

# 配置参考

MimiAgent 从环境变量加载凭证和本机运行设置。推荐的持久位置是 `~/.mimi-agent/.env`；只有部署确实需要其他私有文件时才设置 `MIMI_ENV_FILE`。

仓库中的 [`.env.example`](../../.env.example) 是带注释的完整模板，只能包含占位符。

## Provider 配置

### 单 Provider 兼容配置

使用 `MIMI_MODEL_PROVIDER` 选择一种 Provider。

| Provider | 必填变量 | Transport |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY`、`OPENAI_MODEL` | OpenAI Responses |
| `deepseek` | `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` | Provider adapter |
| `openai-compatible` | `MIMI_PROVIDER_API_KEY`、`MIMI_PROVIDER_BASE_URL`、`MIMI_MODEL` | OpenAI Chat Completions |

`OPENAI_MODELS`、`DEEPSEEK_MODELS`、`MIMI_MODELS` 等可选逗号分隔变量用于填充模型候选。模型 ID 和 Endpoint URL 必须来自当前 Provider 的实际说明。

OpenAI-compatible adapter 不能保证实现全部 OpenAI 能力。Tool Calling、流式响应、图片输入和推理控制取决于 Endpoint 与模型能力。

### 多 Provider Registry

可选 Registry 默认位于 `~/.mimi-agent/models.json`，可通过 `MIMI_MODELS_CONFIG` 覆盖。它保存 Provider 定义、模型能力和凭证对应的环境变量名，不保存 API Key 原值。

注册新的 Provider 与模型：

```bash
mimi provider add acme/example-model \
  --label Acme \
  --transport openai-chat-completions \
  --base-url https://api.example.com/v1 \
  --api-key-env ACME_API_KEY \
  --tool-calling true \
  --context-window 128000
```

Registry 支持以下 Transport：

- `openai-responses`
- `openai-chat-completions`
- `anthropic-messages`
- `google-generate-content`

其他能力参数包括 `--kind agent|image-generation`、`--image-input`、`--image-output`、`--reasoning-high manual|adaptive`、`--reasoning-off` 和 `--manual-budget-tokens`。

管理已注册 Target：

```bash
mimi provider list
mimi provider test acme/example-model
mimi provider set acme/example-model
```

Registry 更新在下一个安全 Run 边界生效，不重启 Daemon。`mimi provider set openai-compatible --base-url ... --model ...` 这类命令更新单 Provider 兼容配置，并默认重启；`--no-restart` 可以关闭重启。

## Mode 与 Security Profile

| 配置 | 可选值 | 含义 |
| --- | --- | --- |
| `MIMI_MODE` | `general`、`plan`、`ultra` | 初始运行模式；Plan 始终只读。 |
| `MIMI_SECURITY_PROFILE` | `safe`、`workstation`、`full-owner` | Runtime 启动时授予的本机能力上限。 |
| `MIMI_OUTPUT_LEVEL` | `answer`、`reasoning`、`tools`、`all` | 终端展示的执行细节等级。 |

安全档位：

- `safe`：只读本机操作。
- `workstation`：允许工作区写入、沙箱 Shell 和有界本机读取；不允许受信 MCP、Computer Use、Connector 外部事务或通用网络写入。
- `full-owner`：在当前操作系统账号下开放完整 owner 能力。

Mode、角色、事件策略、能力就绪状态和启动档位会取交集。切换 Mode 不能扩大启动时的安全边界。修改启动安全变量后需要重启 Daemon。

`MIMI_PERMISSION_MODE` 和旧的 `trusted`、`workspace`、`read-only` 值只作为兼容输入保留。新部署应使用 `MIMI_SECURITY_PROFILE`。

## Runtime 与数据路径

| 变量 | 默认值或用途 |
| --- | --- |
| `MIMI_ENV_FILE` | 私有环境文件，通常是 `~/.mimi-agent/.env`。 |
| `MIMI_DATA_DIR` | Agent 语义状态根目录。 |
| `MIMI_DAEMON_DATA_DIR` | Daemon SQLite、Socket、Outbox、Schedule 和运行配置。 |
| `MIMI_WORKSPACE` | 可信请求或 Session 未提供绑定时使用的后备工作区。 |
| `MIMI_SESSION` | 初始 Session ID。 |
| `MIMI_MODELS_CONFIG` | 多 Provider Registry 路径。 |
| `MIMI_SKILLS_DIR` | 最高优先级的额外 Skills 目录。 |
| `MIMI_MCP_CONFIG` | 显式 MCP 配置路径。 |
| `MIMI_CONNECTORS_CONFIG` | Connector 进程配置路径。 |

Daemon 是全局本机控制面，但不是全局工作区。每个可信 CLI 请求携带实际启动目录，已有 Session 也可以保留工作区绑定。

## Context 与 Memory

| 变量 | 用途 |
| --- | --- |
| `MIMI_HISTORY_LIMIT` | 在模型 Token Budget 之前考虑的最近完整 Transcript 单元上限。 |
| `MIMI_CONTEXT_WINDOW` | 未知且未注册模型的兼容回退；已注册或内置 Profile 优先。 |
| `MIMI_OUTPUT_TOKEN_RESERVE` | 未知模型的输出预留回退值。 |
| `MIMI_EMBEDDING_API_KEY` | 可选的独立 OpenAI-compatible Embedding 凭证。 |
| `MIMI_EMBEDDING_BASE_URL` | 可选 Embedding Endpoint。 |
| `EMBEDDING_MODEL` | Embedding 模型 ID。 |
| `MIMI_MEMORY_RETRIEVAL_MODE` | Memory 检索模式；通常使用 `auto`。 |

未配置 Embedding 时，MemoryHub 使用词法检索；Embedding 失败会回退词法通道，不会让 Agent 整体不可用。

## MCP

确有需要时再把示例复制到工作区：

```bash
cp mcp.example.json mcp.json
MIMI_TRUST_WORKSPACE_MCP="$(pwd)" mimi
```

MimiAgent 接受 `mcpServers` 和 `servers` 两种顶层键。Stdio Server 使用 `command` 与 `args`；远程 Server 使用 `type: "http"` 与 `url`，Header 可以引用环境变量。

在 `MIMI_TRUST_WORKSPACE_MCP` 精确指向可信工作区之前，工作区 MCP 配置不会启用。授予信任前先审查完整配置和 Server 命令。Plan 与不可信外部事件不会继承 owner 的 MCP 工具集。

## Connector 与本机 HTTP

Connector 进程与模型 Runtime 分开配置。请从 [`mimi.connectors.example.json`](../../mimi.connectors.example.json) 和 [Connector Protocol](../CONNECTORS.md) 开始。凭证通过白名单注入隔离 Connector 进程，不应出现在 Tool 参数或源代码中。

可选本机 Endpoint：

| 变量 | 用途 |
| --- | --- |
| `MIMI_WEBHOOK_PORT`、`MIMI_WEBHOOK_TOKEN` | 认证的 localhost Event Webhook；Token 至少 24 个字符。 |
| `MIMI_RUNTIME_HTTP_PORT`、`MIMI_RUNTIME_HTTP_TOKEN` | 认证的 localhost Runtime API；Token 至少 32 个字符。 |

没有独立安全设计时，不要把 CLI、Socket、Webhook、Runtime HTTP API 或 MCP Server 暴露到文档定义的本机信任边界之外。

## 应用配置变化

- Session 模型和 Mode 在下一 Run 生效。
- Registry Target 变化不需要重启 Daemon。
- Connector 配置使用 `mimi daemon connectors reload`；存在无法安全换代的在途工作时会拒绝重载。
- MCP 配置在交互终端中使用 `/mcp reload`。
- 启动安全档位、环境变量和单 Provider 兼容配置通常需要 `mimi daemon restart`。

使用 `mimi daemon doctor` 和 `mimi daemon status --json` 核对实际配置；这些命令不会输出凭证原值。
