<p align="center">
  <strong>English</strong> | <a href="./SECURITY.zh-CN.md">简体中文</a>
</p>

# Security Policy

MimiAgent is a local-first agent for one trusted operating-system user. It can run commands, modify files, use authenticated applications, and perform external actions when configured to do so. It is not a sandbox for hostile tenants and is not a security boundary against arbitrary code already running as the same user.

## Supported Versions

Security fixes are applied to the latest release on `main`. Older releases may not receive backports. Reproduce a report against the latest version before submitting it when possible.

## Reporting a Vulnerability

Do not disclose an exploitable vulnerability, credential, personal record, or private runtime artifact in a public issue.

Use GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, open a public issue that only asks the maintainer for a private contact channel and contains no vulnerability details.

Include:

- affected version and commit;
- deployment and security profile;
- prerequisites and minimal reproduction steps;
- expected and observed behavior;
- impact and affected data or capabilities;
- any suggested mitigation.

The maintainer will validate the report, coordinate a fix and release when applicable, and credit reporters who request attribution. Public disclosure should wait until a fix or agreed mitigation is available.

## Security Profiles

The startup profile is the maximum local capability boundary:

| Profile | Intended use |
| --- | --- |
| Safe | Read-only inspection. |
| Workstation | Workspace writes and sandboxed shell, without trusted MCP, Computer Use, connector transactions, or general network writes. |
| Full Owner | Full local-owner execution under the current operating-system account. |

The effective tool set also intersects the selected mode, work-unit role, event policy, capability readiness, path ownership, and execution-ledger state. Plan is always read-only. A project instruction, Skill, memory page, model response, or external event cannot expand Host authorization.

Use Safe or Workstation for unfamiliar repositories. Full Owner can access any resource available to the operating-system user through permitted tools; private-path filtering in built-in tools is not an operating-system sandbox around an owner shell.

## Core Security Invariants

- External event, page, email, message, document, and connector content is untrusted data, never Host instruction.
- Provenance records origin; it does not authorize actions by itself.
- User-facing sessions and active runs have immutable ownership checks so stale work cannot overwrite current state.
- Function calls and results remain complete protocol units when history is trimmed or recovered.
- Side-effect receipts provide at-most-once protection. Started or uncertain shell, file, MCP, connector, and external transactions are not silently replayed.
- Connector credentials and channel SDKs stay in isolated connector processes.
- Workspace MCP configuration requires explicit trust of the exact workspace.
- SubAgents and Team workers receive narrower capabilities than the main owner session and cannot recursively delegate.
- Persistent state is validated and replaced atomically; unsupported future versions fail closed.
- Daemon control is authenticated and bound to the private local runtime directory.

The detailed enforcement model is documented in [Architecture](./docs/ARCHITECTURE.en.md), [Connectors](./docs/CONNECTORS.md), and [Security Evaluations](./docs/SECURITY_EVALS.md).

## Credentials and Sensitive Data

- Store API keys in `~/.mimi-agent/.env`, another ignored private environment file, or the process environment.
- Keep `.env.example` limited to placeholders.
- Registry files store credential environment-variable names, not credential values.
- Remote MCP headers should reference environment variables instead of embedding tokens in `mcp.json`.
- Do not put secrets in prompts, tool arguments, source files, traces, screenshots, diagnostic bundles, or issues.
- Review generated files before sharing them, even when the command describes them as redacted.

Direct authenticated owner input has a bounded ephemeral-secret path for narrow workflows, but environment-backed configuration remains the preferred method. A secret value must never be passed in a tool argument or persisted to the workspace.

If a secret entered Git history, terminal sharing, logs, an issue, or a model transcript, revoke and rotate it. Removing the current file is not sufficient.

## Skills, MCP, and Connectors

Third-party Skills can influence model behavior and may include scripts. MCP servers can execute local commands or expose remote data. Connectors may carry authenticated external actions and private event content.

Before enabling one:

1. Review its instructions, command, arguments, environment allowlist, and source.
2. Confirm the exact data and accounts it can access.
3. Start with the lowest suitable security profile.
4. Verify read behavior before enabling writes or unattended schedules.
5. Define recovery or audit procedures for external systems that support them.

macOS integrations rely on permissions granted to the actual Node, terminal, or LaunchAgent process. Screen Recording, Accessibility, Automation, Full Disk Access, Contacts, Calendar, Mail, Messages, Microphone, and Speech Recognition can expose sensitive information. Grant only the permissions required by enabled connectors.

## Local Interfaces and Network Boundaries

The Unix socket, optional webhook, and optional runtime HTTP API are designed for authenticated local use. Do not expose them to another host, an untrusted local user, or the public internet without a separate authentication, authorization, rate-limit, and network-isolation design.

Do not connect untrusted MCP servers or allow the agent to query internal services that return sensitive information. The built-in HTTP tool rejects local, private, link-local, metadata, and unsafe redirect targets, but this does not turn arbitrary external integrations into trusted systems.

## Data and Diagnostics

Private runtime state normally lives under `~/.mimi-agent/` and may contain sessions, plans, memory, traces, task metadata, and connector state. Protect backups with the same care as the live directory.

Do not commit or publish:

- `.mimi-agent/` or alternate data roots;
- sessions, traces, SQLite databases, WAL/SHM files, or execution receipts;
- screenshots, recordings, computer artifacts, message attachments, or exported mail;
- real connector configuration, personal identifiers, or private knowledge;
- diagnostic bundles that have not been manually reviewed.

Use `mimi daemon diagnostics <file>` for a bounded redacted artifact and inspect it before sharing. Use `mimi daemon backup verify <directory>` before relying on a backup.
