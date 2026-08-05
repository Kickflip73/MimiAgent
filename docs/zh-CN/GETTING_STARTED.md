<p align="center">
  <a href="../GETTING_STARTED.md">English</a> | <strong>简体中文</strong>
</p>

# 快速入门

这份指南覆盖从源码安装到第一次成功对话。所有可配置项请查阅[配置参考](./CONFIGURATION.md)。

## 1. 检查环境要求

| 依赖 | 最低版本 | 说明 |
| --- | --- | --- |
| Node.js | 22.19.0 | Daemon 使用 Node 内置的 `node:sqlite`。 |
| npm | 10.9.2 | `package.json` 固定使用该 npm 版本。 |
| 模型 Provider | 至少一个 API Key | 支持 OpenAI、DeepSeek 或 OpenAI Chat Completions-compatible 服务。 |
| 操作系统 | 核心运行时支持 macOS 或 Linux | Apple App、桌面、屏幕和语音 Connector 只支持 macOS。 |

确认本机工具链：

```bash
node --version
npm --version
```

## 2. 安装 MimiAgent

```bash
git clone https://github.com/Kickflip73/MimiAgent.git
cd MimiAgent
npm install
npm install -g .
```

`npm install` 会通过 package prepare script 编译 TypeScript；全局安装会提供 `mimi` 命令。贡献者也可以使用 `npm link`，让命令始终指向当前工作树。

检查命令是否可用：

```bash
mimi --version
mimi --help
```

## 3. 配置 Provider

创建私有运行目录并复制环境变量示例：

```bash
mkdir -p ~/.mimi-agent
cp .env.example ~/.mimi-agent/.env
chmod 600 ~/.mimi-agent/.env
```

从以下配置中选择一种。

### OpenAI

```dotenv
MIMI_CONFIG_VERSION=4
MIMI_MODEL_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-id
```

### DeepSeek

```dotenv
MIMI_CONFIG_VERSION=4
MIMI_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=your-model-id
```

### OpenAI-compatible 服务

```dotenv
MIMI_CONFIG_VERSION=4
MIMI_MODEL_PROVIDER=openai-compatible
MIMI_PROVIDER_API_KEY=your-api-key
MIMI_PROVIDER_BASE_URL=https://api.provider.example/v1
MIMI_MODEL=your-model-id
```

兼容 Provider 使用 OpenAI Chat Completions 协议。Tool Calling、流式响应和图片能力取决于服务端实现与模型注册信息。

不要提交 `~/.mimi-agent/.env`，不要把真实 Key 写入 `.env.example`，也不要把凭证粘贴到公开 Issue。

## 4. 执行就绪检查

```bash
mimi daemon doctor
```

Doctor 只做有界本机检查并给出下一步。它不会读取消息正文、邮件、屏幕内容或私人 Memory，也不会自行触发 macOS 权限申请。

查看完整维护命令：

```bash
mimi daemon --help
```

## 5. 开始使用

进入交互式 Session：

```bash
mimi
```

本机 Daemon 会在需要时自动启动。发送第一条普通消息时才会创建 Session；只打开 CLI 不会留下空 Session。

不进入交互界面，直接执行一次任务：

```bash
mimi "读取 package.json 并介绍这个项目"
```

建议先熟悉这些斜杠命令：

```text
/status
/models
/model
/mode
/security
/skills
/mcp
/help
```

## 6. 检查后台服务

```bash
mimi daemon status
mimi daemon status --json
```

可读输出适合人工运维，`--json` 适合脚本和完整诊断。

生命周期命令：

```bash
mimi daemon start
mimi daemon stop
mimi daemon restart
```

使用 `restart --force` 前先阅读帮助。它可以中断没有在途 Tool 的模型 Run，但仍会拒绝跨越结果不确定的副作用边界。

## 7. 了解数据位置

默认私有运行根目录是 `~/.mimi-agent/`，其中保存环境文件、Daemon 状态、Session、Plan、Memory、Trace 和生成的运行配置。初始化时会收紧目录与文件权限。

不要把该目录加入仓库、备份到公开位置或用作测试 Fixture。单元测试使用隔离临时目录，不依赖真实用户状态。

## 下一步

- 在[配置参考](./CONFIGURATION.md)中设置安全档位和高级 Provider 配置。
- 在 [CLI 与 Daemon 参考](./CLI.md)中查找终端、斜杠、Daemon、Schedule 和恢复命令。
- 从[文档索引](../README.zh-CN.md)开始配置 Skill、MCP Server 或 Connector。
- 启用 Full Owner、受信 MCP、Computer Use 或外部操作前阅读[安全策略](../../SECURITY.zh-CN.md)。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| `mimi: command not found` | 重新运行 `npm install -g .`，并确认 npm 全局 bin 目录已加入 `PATH`。 |
| Provider 认证失败 | 检查 `~/.mimi-agent/.env` 中的 Provider、Key 变量、Base URL 和精确模型 ID。 |
| 重新构建后 Daemon 仍像旧版本 | 运行 `npm install -g .` 和 `mimi daemon restart`；用 `mimi daemon doctor` 检查 Build Identity 漂移。 |
| 工作区 MCP Server 不可用 | 检查配置路径，并使用 `MIMI_TRUST_WORKSPACE_MCP` 显式信任工作区。 |
| macOS 集成不可用 | 检查 Connector 状态，以及系统权限是否授予了实际 Node、Terminal 或 LaunchAgent 进程。 |

需要提供支持信息时，运行 `mimi daemon diagnostics <output-file>` 生成脱敏诊断包，并在分享前自行检查内容。
