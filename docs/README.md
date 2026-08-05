<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

# MimiAgent Documentation

This index separates user guides, operational references, architecture material, compatibility contracts, and project governance. Start with the shortest document that answers your question; the root README is intentionally only an overview.

## Choose a Path

| I want to... | Read |
| --- | --- |
| Install MimiAgent and start the first session | [Getting Started](./GETTING_STARTED.md) |
| Configure a provider, security profile, data path, MCP, or connectors | [Configuration](./CONFIGURATION.md) |
| Find a terminal, slash, or daemon command | [CLI and Daemon Reference](./CLI.md) |
| Understand the runtime and state model | [Architecture Overview](./ARCHITECTURE.en.md) |
| Add a connector or inspect its protocol | [Connector Protocol](./CONNECTORS.md) |
| Contribute code or documentation | [Contributing Guide](../CONTRIBUTING.md) |
| Report a vulnerability or review the threat model | [Security Policy](../SECURITY.md) |

## User Guides

| Document | English | 简体中文 |
| --- | --- | --- |
| Project overview | [README](../README.md) | [README](../README.zh-CN.md) |
| Getting started | [Guide](./GETTING_STARTED.md) | [指南](./zh-CN/GETTING_STARTED.md) |
| Configuration | [Reference](./CONFIGURATION.md) | [参考](./zh-CN/CONFIGURATION.md) |
| CLI and daemon | [Reference](./CLI.md) | [参考](./zh-CN/CLI.md) |

## Architecture and Operations

| Document | Scope | Language |
| --- | --- | --- |
| [Architecture overview](./ARCHITECTURE.en.md) | Module boundaries, runtime lanes, state ownership, tool policy, extension model | English |
| [Detailed architecture](./ARCHITECTURE.md) | Authoritative design invariants and detailed runtime behavior | 简体中文 |
| [Attention and proactive briefings](./ATTENTION.md) | Attention policy, routines, standing orders, digests | 简体中文 |
| [Connector protocol](./CONNECTORS.md) | NDJSON protocol, action bridge, built-in connector examples | English and 简体中文 |
| [Computer Use](./COMPUTER_USE.md) | Native computer observation/action contracts and safety boundaries | 简体中文 |
| [Local capacity benchmarks](./BENCHMARKS.md) | Reproducible local benchmark scope and interpretation | 简体中文 |

## Contracts and Evaluation

| Document | Purpose |
| --- | --- |
| [Public API](./PUBLIC_API.md) | Supported package entry points and compatibility rules |
| [Provider contracts](./PROVIDER_CONTRACTS.md) | Offline provider behavior and fixture contract |
| [Provider canary](./PROVIDER_CANARY.md) | Optional real-provider smoke test |
| [Security evaluations](./SECURITY_EVALS.md) | Permission and prompt-injection test matrix |
| [Repository boundaries](./REPOSITORY_BOUNDARIES.md) | Product, package, experimental, and workspace asset ownership |

## Design Records

These documents explain a decision or implementation program. They are useful historical context, but current behavior is defined by the code, tests, and architecture contract.

| Document | Status |
| --- | --- |
| [State storage decision](./STATE_STORAGE_DECISION.md) | Architecture decision record |
| [Agent Skills interoperability plan](./AGENT_SKILLS_INTEROPERABILITY_PLAN.md) | Completed implementation plan |

## Project Governance

- [Contributing](../CONTRIBUTING.md) / [贡献指南](../CONTRIBUTING.zh-CN.md)
- [Security](../SECURITY.md) / [安全策略](../SECURITY.zh-CN.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md) / [行为准则](../CODE_OF_CONDUCT.zh-CN.md)
- [Changelog](../CHANGELOG.md)
- [License](../LICENSE)

## Documentation Conventions

- English is the default language for new top-level public documentation. Simplified Chinese translations live beside the source with `.zh-CN.md` or under `docs/zh-CN/`.
- Keep command names, environment variables, paths, and code identifiers identical across translations.
- A user-visible behavior change should update the relevant guide in both languages in the same pull request.
- Architecture details belong in architecture documents; setup steps belong in guides; compatibility promises belong in contract documents; time-bound investigation notes belong in design records.
- Prefer links to a single source of truth instead of copying long capability or configuration lists into the README.
