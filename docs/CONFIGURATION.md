<p align="center">
  <strong>English</strong> | <a href="./zh-CN/CONFIGURATION.md">简体中文</a>
</p>

# Configuration Reference

MimiAgent loads secrets and local runtime settings from environment variables. The recommended persistent location is `~/.mimi-agent/.env`; set `MIMI_ENV_FILE` only when a deployment needs another private file.

The checked-in [`.env.example`](../.env.example) is the complete annotated template. It must contain placeholders only.

## Provider Setup

### Legacy single-provider variables

Choose one provider with `MIMI_MODEL_PROVIDER`.

| Provider | Required variables | Transport |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI Responses |
| `deepseek` | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` | Provider adapter |
| `openai-compatible` | `MIMI_PROVIDER_API_KEY`, `MIMI_PROVIDER_BASE_URL`, `MIMI_MODEL` | OpenAI Chat Completions |

Optional comma-separated variables such as `OPENAI_MODELS`, `DEEPSEEK_MODELS`, and `MIMI_MODELS` populate model choices. Model IDs and endpoint URLs must come from the provider currently being used.

The OpenAI-compatible adapter cannot guarantee every OpenAI feature. Tool calling, streaming, image input, and reasoning controls depend on the endpoint and model capabilities.

### Multi-provider registry

The optional registry defaults to `~/.mimi-agent/models.json`; override it with `MIMI_MODELS_CONFIG`. It stores provider definitions, model capabilities, and the environment-variable name that owns each credential. It never stores the API-key value.

Register a new provider and model:

```bash
mimi provider add acme/example-model \
  --label Acme \
  --transport openai-chat-completions \
  --base-url https://api.example.com/v1 \
  --api-key-env ACME_API_KEY \
  --tool-calling true \
  --context-window 128000
```

Supported registry transports are:

- `openai-responses`
- `openai-chat-completions`
- `anthropic-messages`
- `google-generate-content`

Additional capability flags include `--kind agent|image-generation`, `--image-input`, `--image-output`, `--reasoning-high manual|adaptive`, `--reasoning-off`, and `--manual-budget-tokens`.

Manage registered targets:

```bash
mimi provider list
mimi provider test acme/example-model
mimi provider set acme/example-model
```

Registry updates take effect at the next safe Run boundary and do not restart the daemon. A command such as `mimi provider set openai-compatible --base-url ... --model ...` updates the legacy single-provider configuration and restarts by default; `--no-restart` disables that restart.

## Modes and Security Profiles

| Setting | Values | Meaning |
| --- | --- | --- |
| `MIMI_MODE` | `general`, `plan`, `ultra` | Initial execution mode. Plan is always read-only. |
| `MIMI_SECURITY_PROFILE` | `safe`, `workstation`, `full-owner` | Maximum local capability granted when the runtime starts. |
| `MIMI_OUTPUT_LEVEL` | `answer`, `reasoning`, `tools`, `all` | Amount of execution detail rendered by the terminal. |

Security profiles:

- `safe`: read-only local operation.
- `workstation`: workspace writes, sandboxed shell, and bounded local reads; no trusted MCP, Computer Use, connector external transactions, or general network writes.
- `full-owner`: full local-owner capability under the operating-system account.

Mode, role, event policy, capability readiness, and the startup profile are intersected. Changing mode cannot expand the startup security boundary. Restart the daemon after changing startup security variables.

`MIMI_PERMISSION_MODE` and older `trusted`, `workspace`, and `read-only` values remain compatibility inputs. New deployments should configure `MIMI_SECURITY_PROFILE`.

## Runtime and Data Paths

| Variable | Default or purpose |
| --- | --- |
| `MIMI_ENV_FILE` | Private environment file; normally `~/.mimi-agent/.env`. |
| `MIMI_DATA_DIR` | Agent semantic state root. |
| `MIMI_DAEMON_DATA_DIR` | Daemon SQLite, socket, outbox, schedules, and runtime configuration. |
| `MIMI_WORKSPACE` | Fallback workspace when no trusted request or session binding supplies one. |
| `MIMI_SESSION` | Initial session identifier. |
| `MIMI_MODELS_CONFIG` | Multi-provider registry path. |
| `MIMI_SKILLS_DIR` | Highest-priority additional Skills directory. |
| `MIMI_MCP_CONFIG` | Explicit MCP configuration path. |
| `MIMI_CONNECTORS_CONFIG` | Connector process configuration path. |

The daemon is a global local control plane, but it is not a global workspace. Each trusted CLI request carries its actual startup directory; an existing session may also retain a workspace binding.

## Context and Memory

| Variable | Purpose |
| --- | --- |
| `MIMI_HISTORY_LIMIT` | Maximum recent transcript units considered before model-specific token budgeting. |
| `MIMI_CONTEXT_WINDOW` | Legacy fallback for unknown, unregistered models. Registered or built-in profiles take precedence. |
| `MIMI_OUTPUT_TOKEN_RESERVE` | Legacy output reserve fallback for unknown models. |
| `MIMI_EMBEDDING_API_KEY` | Optional independent OpenAI-compatible embedding credential. |
| `MIMI_EMBEDDING_BASE_URL` | Optional embedding endpoint. |
| `EMBEDDING_MODEL` | Embedding model ID. |
| `MIMI_MEMORY_RETRIEVAL_MODE` | Memory retrieval mode; `auto` is the normal choice. |

Without embeddings, MemoryHub uses its lexical path. Embedding failure falls back to lexical retrieval instead of making the agent unavailable.

## MCP

Copy the example configuration into a workspace only when needed:

```bash
cp mcp.example.json mcp.json
MIMI_TRUST_WORKSPACE_MCP="$(pwd)" mimi
```

MimiAgent accepts `mcpServers` and `servers` as top-level keys. Stdio servers use `command` and `args`; remote servers use `type: "http"` and `url`. Headers may reference environment variables.

Workspace MCP configuration is disabled until `MIMI_TRUST_WORKSPACE_MCP` exactly identifies the trusted workspace. Review the full file and server command before granting trust. Plan and untrusted external events do not inherit the owner's MCP tool set.

## Connectors and Local HTTP

Connector processes are configured separately from the model runtime. Start with [`mimi.connectors.example.json`](../mimi.connectors.example.json) and the [Connector Protocol](./CONNECTORS.md). Credentials are allowlisted into isolated connector processes and should not be added to tool arguments or source files.

Optional local endpoints:

| Variable | Purpose |
| --- | --- |
| `MIMI_WEBHOOK_PORT`, `MIMI_WEBHOOK_TOKEN` | Authenticated localhost event webhook. Use a token of at least 24 characters. |
| `MIMI_RUNTIME_HTTP_PORT`, `MIMI_RUNTIME_HTTP_TOKEN` | Authenticated localhost runtime API. Use a token of at least 32 characters. |

Do not bind the CLI, socket, webhook, runtime HTTP API, or MCP servers beyond their documented local trust boundary without a separate security design.

## Applying Changes

- Session model and mode changes apply to the next Run.
- Registry target changes apply without a daemon restart.
- Connector configuration changes use `mimi daemon connectors reload` and are rejected while unsafe in-flight work prevents replacement.
- MCP changes use `/mcp reload` in the interactive terminal.
- Startup security, environment, and legacy provider changes normally require `mimi daemon restart`.

Use `mimi daemon doctor` and `mimi daemon status --json` to confirm the effective configuration without exposing secret values.
