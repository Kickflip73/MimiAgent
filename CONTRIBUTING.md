<p align="center">
  <strong>English</strong> | <a href="./CONTRIBUTING.zh-CN.md">简体中文</a>
</p>

# Contributing to MimiAgent

Thank you for helping improve MimiAgent. Contributions should make the local agent more useful, reliable, understandable, or secure while preserving its lightweight architecture and explicit permission boundaries.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before You Start

- Search existing issues and pull requests before opening a duplicate.
- For a focused bug fix or documentation correction, a pull request is welcome directly.
- For a new built-in tool, durable-state format, public API change, large dependency, or architectural change, open an issue first and explain the use case and smallest compatible design.
- Do not disclose security vulnerabilities in public issues. Follow [SECURITY.md](./SECURITY.md).

## Development Setup

Requirements:

- Node.js 22.19.0 or newer
- npm 10 or newer
- Git

```bash
git clone https://github.com/Kickflip73/MimiAgent.git
cd MimiAgent
npm install
npm link
mimi --help
```

API keys are not required for unit tests, type checking, builds, packaging checks, or local retrieval evaluation. Keep any optional real-provider credentials in `~/.mimi-agent/.env` or another ignored private environment file.

## Repository Structure

| Path | Responsibility |
| --- | --- |
| `src/runtime/` | Composition, execution lifecycle, providers, modes, permissions, and runtime effects |
| `src/core/` | Durable agent semantics and validated state |
| `src/extensions/` | Optional Skills, MCP, retrieval, SubAgent, and Team capabilities |
| `src/daemon/` | Reliable events, leases, schedules, IPC, connectors, and notifications |
| `src/tools.ts` | Small, generic, high-frequency host tools |
| `tests/` | Deterministic Node test-runner coverage |
| `docs/` | User guides, architecture, operations, contracts, and design records |

Read [AGENTS.md](./AGENTS.md) and the [architecture contract](./docs/ARCHITECTURE.en.md) before changing runtime or durable-state behavior.

## Working Agreement

1. Inspect the relevant source, nearby tests, and current documentation.
2. Define the smallest observable outcome that solves the problem.
3. Add or update a focused test for behavioral changes.
4. Keep the patch scoped; do not reformat or refactor unrelated code.
5. Run the narrowest relevant check first, then the broader required checks.
6. Review the final diff for generated files, secrets, stale documentation, and unrelated changes.

TypeScript code uses ESM, strict mode, NodeNext resolution, ES2022, two-space indentation, semicolons, and single quotes. Relative imports include `.js` extensions. Use `node:` imports for Node built-ins and `import type` for type-only dependencies.

## Architecture Rules

- The CLI and daemon share one main agent host; a user-facing session has one owner.
- SubAgents are bounded, one level deep, and never own the final response.
- Plan is read-only. Ultra is limited to explicit dependencies, non-overlapping write paths, and at most four workers.
- Preserve provider alignment unless a documented protocol capability requires a difference.
- Never split `function_call` from its matching `function_call_result` while trimming history.
- Do not persist temporary summaries or retrieval results as conversation history.
- Scope active-run writes by immutable session and run ownership.
- Route persistent JSON through validated atomic stores; do not add ad hoc read-modify-write state.
- Never silently replay an uncertain shell, file, MCP, connector, or external transaction.
- Prefer a Skill, MCP integration, Connector, or composition of existing tools before adding a built-in tool.

## Verification

Choose checks based on risk:

| Change | Required checks |
| --- | --- |
| Documentation only | Validate links, examples, and `npm run check:repo` |
| Small implementation | `npm run check` and focused tests |
| Runtime, core, or daemon behavior | `npm run check && npm test && npm run build` |
| Retrieval | Add `npm run eval` |
| Packaging, exports, CLI entry, or published files | Add `npm run test:package` |
| Release-ready | `npm run ci` when practical |

Real-provider checks such as `npm run eval:agent` and macOS UI tests are opt-in. Do not make ordinary tests depend on API keys, the public internet, or a user's `~/.mimi-agent` data.

## Documentation

- Keep the root README short. Put setup, configuration, CLI, architecture, and security detail in their dedicated documents.
- Update English and Simplified Chinese versions together for user-visible behavior.
- Keep commands, paths, environment variables, and identifiers identical across translations.
- Use the [documentation index](./docs/README.md) to classify new documents.
- Update `CHANGELOG.md` for release-relevant behavior.

## Commits and Pull Requests

- Create a focused branch from `main`.
- Use Conventional Commits, for example `fix(session): preserve tool result pairing`.
- Keep commits reviewable and avoid generated `dist/` output.
- Explain the motivation, behavior change, verification performed, and documentation impact in the pull request.
- Link the issue when one exists.
- Include a regression test for a bug whenever practical.

The pull request must not contain `.env`, API keys, tokens, personal data, `.mimi-agent/`, sessions, traces, local databases, screenshots, recordings, or unrelated workspace assets.
