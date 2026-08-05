<p align="center">
  <strong>English</strong> | <a href="./zh-CN/GETTING_STARTED.md">简体中文</a>
</p>

# Getting Started

This guide takes a new local installation from source checkout to the first successful conversation. For every available setting, use the [configuration reference](./CONFIGURATION.md).

## 1. Check the Requirements

| Requirement | Minimum | Notes |
| --- | --- | --- |
| Node.js | 22.19.0 | The daemon uses the built-in `node:sqlite` module. |
| npm | 10.9.2 | The repository pins this package-manager release in `package.json`. |
| Model provider | One API key | OpenAI, DeepSeek, or an OpenAI Chat Completions-compatible endpoint. |
| Operating system | macOS or Linux for the core runtime | Native Apple-app, desktop, screen, and voice connectors require macOS. |

Confirm the local toolchain:

```bash
node --version
npm --version
```

## 2. Install MimiAgent

```bash
git clone https://github.com/Kickflip73/MimiAgent.git
cd MimiAgent
npm install
npm install -g .
```

`npm install` builds the TypeScript sources through the package prepare script. The global installation exposes the `mimi` command. Contributors may use `npm link` instead so the command follows the current working tree.

Verify the command:

```bash
mimi --version
mimi --help
```

## 3. Configure a Provider

Create the private runtime directory and copy the example environment file:

```bash
mkdir -p ~/.mimi-agent
cp .env.example ~/.mimi-agent/.env
chmod 600 ~/.mimi-agent/.env
```

Choose one provider configuration.

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

### OpenAI-compatible endpoint

```dotenv
MIMI_CONFIG_VERSION=4
MIMI_MODEL_PROVIDER=openai-compatible
MIMI_PROVIDER_API_KEY=your-api-key
MIMI_PROVIDER_BASE_URL=https://api.provider.example/v1
MIMI_MODEL=your-model-id
```

The compatible provider uses the OpenAI Chat Completions protocol. Tool calling, streaming, and image support depend on the endpoint implementation and the model registration.

Never commit `~/.mimi-agent/.env`, copy a real key into `.env.example`, or paste credentials into a public issue.

## 4. Run the Readiness Check

```bash
mimi daemon doctor
```

Doctor performs bounded local checks and reports the next action. It does not read message bodies, mail, screen content, or personal memory, and it does not request macOS permissions by itself.

To inspect the full maintenance command set:

```bash
mimi daemon --help
```

## 5. Start Using MimiAgent

Start an interactive session:

```bash
mimi
```

The local daemon starts automatically when required. The first ordinary message creates the session; opening the CLI alone does not leave an empty session behind.

Run one task without entering the interactive interface:

```bash
mimi "Read package.json and explain this project"
```

Useful first commands inside the interactive terminal:

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

## 6. Check the Background Service

```bash
mimi daemon status
mimi daemon status --json
```

The readable form is intended for operators; `--json` is intended for scripts and complete diagnostics.

Lifecycle commands:

```bash
mimi daemon start
mimi daemon stop
mimi daemon restart
```

Use `restart --force` only after reading its help. It may interrupt model runs that have no tool in flight, but it still refuses to cross an uncertain side-effect boundary.

## 7. Know Where Data Lives

The default private runtime root is `~/.mimi-agent/`. It contains the environment file, daemon state, sessions, plans, memory, traces, and generated runtime configuration. Permissions are restricted during initialization.

Do not add that directory to a repository, back it up to a public location, or use it as a test fixture. Unit tests create isolated temporary roots and never require real user state.

## Next Steps

- Select security profiles and advanced provider settings in [Configuration](./CONFIGURATION.md).
- Learn terminal, slash, daemon, schedule, and recovery commands in [CLI and Daemon Reference](./CLI.md).
- Add Skills, MCP servers, or Connector processes from the [documentation index](./README.md).
- Review the [Security Policy](../SECURITY.md) before enabling Full Owner, trusted MCP, Computer Use, or external actions.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `mimi: command not found` | Run `npm install -g .` again and confirm npm's global bin directory is in `PATH`. |
| Provider authentication fails | Check the selected provider, key variable, base URL, and exact model ID in `~/.mimi-agent/.env`. |
| The daemon appears stale after rebuilding | Run `npm install -g .`, then `mimi daemon restart`; use `mimi daemon doctor` to inspect build identity drift. |
| A workspace MCP server is unavailable | Confirm the config path and explicitly trust the workspace with `MIMI_TRUST_WORKSPACE_MCP`. |
| A macOS integration is unavailable | Check Connector status and the operating-system permissions granted to the actual Node, Terminal, or LaunchAgent process. |

For a redacted support artifact, run `mimi daemon diagnostics <output-file>` and inspect the file before sharing it.
