<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

# MimiAgent

> A lightweight, local-first personal AI agent that can stay available, remember context, and complete real work from the terminal or a durable background service.

[![CI](https://github.com/Kickflip73/MimiAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Kickflip73/MimiAgent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MimiAgent is built with TypeScript and the OpenAI Agents SDK. Its interactive CLI and always-on daemon share the same agent host, sessions, memory, tools, Skills, MCP integrations, and execution controls. It is designed for local use by one trusted owner, not as a multi-tenant workflow platform.

## Why MimiAgent

- **One agent, two entry points.** Use an interactive terminal or submit work to the same durable background runtime.
- **Local-first state.** Sessions, plans, memory, traces, and task state stay on the machine by default.
- **Work that survives the terminal.** Long-running tasks are persisted, supervised in bounded worker processes, and reported back when finished.
- **Provider-aware execution.** Route conversations, background work, subagents, team tasks, and media work to compatible models.
- **Extensions without a heavy kernel.** Add reusable behavior through Agent Skills, MCP, and isolated Connector processes.
- **Explicit safety boundaries.** Modes, security profiles, event provenance, scoped tools, and execution receipts constrain what can run and what may be retried.

## How It Fits Together

```text
CLI / local events / schedules / connectors
                    |
                    v
          durable MimiAgent daemon
        +---------------------------+
        | Session actors            |  same session: FIFO
        | Background task workers   |  different sessions: bounded parallelism
        | Inbox / Outbox / leases   |  crash recovery and delivery retries
        +---------------------------+
                    |
                    v
        runtime -> core + extensions + tools
```

The main agent owns every user-facing session and final answer. Subagents are one level deep and bounded; Ultra teams run at most four workers with explicit dependencies and non-overlapping write paths.

Read the [architecture overview](./docs/ARCHITECTURE.en.md) for the runtime and state invariants.

## Quick Start

### Requirements

- Node.js 22.19.0 or newer
- npm 10.9.2 (the version pinned by the repository)
- A model-provider API key
- macOS only for the optional native desktop, Mail, Messages, Calendar, Notes, Contacts, Shortcuts, screen, and voice connectors

### Install from source

```bash
git clone https://github.com/Kickflip73/MimiAgent.git
cd MimiAgent
npm install
npm install -g .
mkdir -p ~/.mimi-agent
cp .env.example ~/.mimi-agent/.env
```

Configure one provider in `~/.mimi-agent/.env`:

```dotenv
MIMI_CONFIG_VERSION=4
MIMI_MODEL_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-id
```

Then check the installation and start a conversation:

```bash
mimi daemon doctor
mimi
```

The daemon starts automatically when needed. You can also run one task directly:

```bash
mimi "Inspect this repository and summarize its architecture"
```

See the [getting-started guide](./docs/GETTING_STARTED.md) for DeepSeek, OpenAI-compatible endpoints, daemon operation, and troubleshooting.

## Modes and Security

MimiAgent calculates the effective tool set from the selected mode, the startup security profile, the work-unit role, connector readiness, and event policy.

| Control | Purpose |
| --- | --- |
| General | Normal interactive and task execution within the active security profile. |
| Plan | Read-only analysis and planning. Tool selection enforces the boundary. |
| Ultra | Bounded team execution with explicit task dependencies and path ownership. |
| Safe | Read-only local operation. |
| Workstation | Workspace writes and sandboxed shell, without trusted MCP, Computer Use, connector transactions, or general network writes. |
| Full Owner | Full local-owner capability under the current operating-system account. |

> [!IMPORTANT]
> Full Owner can perform real local and external actions. Use Safe or Workstation for unfamiliar repositories, review third-party Skills and MCP servers before enabling them, and keep credentials out of the workspace.

Read the [security policy](./SECURITY.md) before enabling unattended execution or external connectors.

## Extending MimiAgent

| Extension | Use it for | Entry point |
| --- | --- | --- |
| Agent Skills | Reusable instructions, scripts, and supporting resources | `skills/<name>/SKILL.md` |
| MCP | External tools and resources exposed by trusted MCP servers | `mcp.json` |
| Connectors | Durable event sources and external actions in isolated processes | `mimi.connectors.example.json` |
| Public package API | Embedding the host or orchestration primitives in TypeScript | `mimi-agent`, `mimi-agent/orchestration` |

The built-in tool surface stays intentionally small. Domain-specific or low-frequency behavior should normally be implemented as a Skill, MCP integration, or Connector.

## Documentation

| Start here | English | 简体中文 |
| --- | --- | --- |
| Documentation index | [Open](./docs/README.md) | [打开](./docs/README.zh-CN.md) |
| Getting started | [Guide](./docs/GETTING_STARTED.md) | [指南](./docs/zh-CN/GETTING_STARTED.md) |
| Configuration | [Reference](./docs/CONFIGURATION.md) | [参考](./docs/zh-CN/CONFIGURATION.md) |
| CLI and daemon | [Reference](./docs/CLI.md) | [参考](./docs/zh-CN/CLI.md) |
| Architecture | [Overview](./docs/ARCHITECTURE.en.md) | [详细设计](./docs/ARCHITECTURE.md) |
| Contributing | [Guide](./CONTRIBUTING.md) | [指南](./CONTRIBUTING.zh-CN.md) |
| Security | [Policy](./SECURITY.md) | [策略](./SECURITY.zh-CN.md) |

Additional design references, operational notes, evaluations, and compatibility contracts are organized in the [documentation index](./docs/README.md).

## Development

```bash
npm run check
npm test
npm run build
```

Use `npm run ci` for the full repository, coverage, build, and package verification pipeline. Tests do not require API keys or access to real user state. Real-provider evaluations are opt-in.

Before opening a pull request, read [CONTRIBUTING.md](./CONTRIBUTING.md), the [Code of Conduct](./CODE_OF_CONDUCT.md), and the repository-wide guidance in `AGENTS.md`.

## Project Status

MimiAgent is under active development. Public entry points follow semantic-versioning rules, but operational behavior and extension contracts may continue to evolve before 1.0. See the [changelog](./CHANGELOG.md) for release details.

## License

MimiAgent is available under the [MIT License](./LICENSE).
