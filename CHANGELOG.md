# Changelog

All notable changes to MimiAgent are documented here.

## Unreleased

- No unreleased changes.

## [0.12.0] - 2026-08-05

### Added

- Local-first CLI and durable daemon runtime built on the OpenAI Agents SDK.
- Session, Goal, Plan, Team, Memory, Connector, Browser, Computer, and scheduled task support.
- Provider-aware model routing for OpenAI, DeepSeek, and OpenAI-compatible endpoints.
- Atomic state stores, execution receipts, retry fencing, and bounded diagnostic tools.
- Public Connector examples for macOS services, browser access, RSS/weather, and file activity.

### Security

- Keep credentials in ignored environment files or process environment variables.
- Treat external event and page content as untrusted data.
- Bind daemon control to an authenticated owner-only local socket.
- Prevent uncertain external actions from being replayed automatically.
- Exclude runtime databases, sessions, traces, personal data, generated assets, and private workspace material from the repository and package.

## [0.1.0] - 2026-07-13

- Initial public release.
