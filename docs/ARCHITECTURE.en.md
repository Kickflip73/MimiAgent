<p align="center">
  <strong>English</strong> | <a href="./ARCHITECTURE.md">简体中文</a>
</p>

# MimiAgent Architecture Overview

MimiAgent is a local-first personal agent and a lightweight orchestration library. It combines an interactive terminal, a durable background runtime, persistent agent semantics, and optional integrations without turning the core into a general workflow platform.

The [detailed Simplified Chinese architecture](./ARCHITECTURE.md) is the authoritative long-form design contract. This document is the English map of the same system boundaries and invariants.

## Design Goals

- Use the OpenAI Agents SDK for the model loop, function tools, MCP, and agents-as-tools.
- Keep one main agent host shared by the CLI and daemon.
- Give exactly one owner to every user-facing session and final answer.
- Keep the runtime small, provider-aware, and understandable from source.
- Persist work before asynchronous execution and preserve at-most-once boundaries around uncertain side effects.
- Extend low-frequency or domain-specific behavior through Skills, MCP, or Connectors.
- Keep General, Plan, and Ultra as tool-enforced capability contracts.

## Dependency Direction

```text
CLI / Daemon
      |
      v
   runtime
   /  |  \
  v   v   v
core extensions tools

extensions -> core when persistent agent state is required
core -X-> runtime, CLI, daemon
```

| Layer | Responsibility |
| --- | --- |
| CLI | Parse commands, collect input, and render runtime events. |
| Daemon | Persist and dispatch events, supervise background work, deliver outbox messages, and host local control endpoints. |
| Runtime | Compose providers, sessions, tools, modes, policy, hooks, and the Agents SDK run lifecycle. |
| Core | Own durable agent semantics: sessions, context, memory contracts, plans, goals, teams, traces, and atomic state. |
| Extensions | Add optional Skills, MCP, retrieval, browser/computer ports, subagents, and team execution. |
| Tools | Provide a deliberately small set of generic, high-frequency host capabilities. |

Implementations must not put runtime composition into `core`, durable state ownership into the CLI, or connector credentials into the model runtime.

## Runtime Shape

```text
CLI / authenticated local API / connector events / schedules
                              |
                              v
                      one durable Kernel
               +--------------+--------------+
               |                             |
               v                             v
       Conversation lane                Task lane
     Session A actor: FIFO         persistent background Task
     Session B actor: FIFO              |
     bounded cross-session              v
         concurrency              supervised OS worker
               |                             |
               +-------------+---------------+
                             v
                    Event outcome + Outbox
```

The Kernel is the single local control plane. It owns the durable inbox, task and run leases, outbox, schedules, attention policy, connector broker, and notifications. It does not call a model while idle.

Conversation actors are in-process isolation units. Calls targeting the same session run strictly in order; different sessions may run concurrently within a bounded global limit.

Long-running work that does not need to block the current conversation is persisted before acceptance. The task supervisor launches a separate operating-system worker with an independent task session and the resolved workspace. Completion or an input request returns through the durable event and outbox path.

## One Conversation Run

```text
1. Authenticate the local request or classify the external event.
2. Persist the event before model execution.
3. Resolve the user-facing session and trusted workspace binding.
4. Capture an immutable run ID, owner, provider binding, mode, and policy.
5. Load canonical transcript, guidance, memory, Goal, Plan, Team, and checkpoint state.
6. Derive a bounded model context without rewriting the canonical transcript.
7. Build the effective capability registry and expose the selected tool surface.
8. Stream the Agents SDK run and persist tool protocol units intact.
9. Evaluate completion from actual receipts, artifacts, tests, and task state.
10. Commit the run outcome and any outbox work atomically where required.
```

The model can propose an answer, but the Host owns the final run state. Execution tasks are not complete merely because the model says they are complete.

## Sessions and Context

The canonical session transcript is separate from every derived or temporary context form:

- full SDK transcript;
- structured context archive;
- run checkpoint;
- Plan, Goal, and Team state;
- MemoryHub pages and retrieval results;
- generated summaries and context artifacts.

History trimming starts at user-message boundaries and must preserve complete protocol units:

```text
user -> function_call -> function_call_result -> assistant
```

Temporary retrieval results and summaries are never persisted as fake user or assistant messages. A context view may replace verified old prefixes with an archive, but it does not rewrite the canonical transcript.

Every write that belongs to an active run is scoped by immutable session and run ownership. Compare-and-swap checks prevent an interrupted or stale run from overwriting current state.

## Durable Event Processing

The daemon uses SQLite WAL for the reliable control plane and JSON, JSONL, Markdown, or dedicated SQLite catalogs for the agent semantics they already own.

Durability rules:

- persist an event before execution;
- claim work through bounded leases;
- recover expired leases without assuming an external action did not happen;
- atomically commit event outcome with outbox creation;
- retry delivery independently from model execution;
- preserve dead-letter state for explicit operator review;
- deduplicate stable source event IDs within the retention window.

Shell commands, file writes, MCP calls, connector actions, and external transactions use execution receipts or equivalent ledgers. A started or uncertain effect is not silently replayed.

## Tools and Capability Policy

All tool sources are projected into one Host capability registry before a Run:

- built-in host tools;
- Browser and Computer ports;
- Memory, Goal, Plan, Skill, and task tools;
- trusted MCP server tools and resources;
- Connector action capabilities.

The effective set is the intersection of:

```text
startup security profile
  x mode
  x work-unit role
  x event/source policy
  x capability readiness
  x path and ownership restrictions
  x execution-ledger state
```

Capability discovery does not grant permission. Deferred tools remain behind the same registry and policy checks when invoked. Unknown, stale, undiscovered, or unavailable capabilities fail closed.

External event and page content is always untrusted data. Provenance records where content came from; it is not itself authorization. Only Host-owned source policy may grant a fixed, bounded action profile.

## Modes and Multi-Agent Work

| Mode or worker | Contract |
| --- | --- |
| General | Normal direct work inside the effective security profile. |
| Plan | Read-only analysis, architecture, and planning. |
| Ultra | Dependency-aware team execution with at most four workers. |
| SubAgent | One-level, bounded delegation; no final-answer ownership and no recursive delegation. |
| Background task | Persisted work with its own task session, worker process, checkpoint, and completion notification. |

Ultra tasks declare dependencies and path ownership before builder execution. Builders must not write overlapping paths. The main agent remains responsible for integration and the final user-facing response.

Long-running state belongs in Goal, Plan, Team, and Checkpoint. MimiAgent does not create a second workflow or todo subsystem.

## Provider and Model Routing

Work units declare a scenario, complexity, hard capabilities, and an optional exact model target. The resolver selects a registered target without reading free-form task text for provider routing.

The selected run binding freezes:

- provider and model IDs;
- transport adapter;
- scenario and selection reason;
- context window and output budget;
- tool calling, image, and reasoning capabilities;
- route version and fallback eligibility.

Adapters isolate OpenAI Responses, OpenAI Chat Completions-compatible, Anthropic Messages, and Google Generate Content protocols. Fallback is allowed only before streaming, tool execution, or another side effect begins.

Credentials remain environment-backed. The registry stores the environment-variable name, not the secret value. Background workers receive only the selected provider credential.

## Memory and Guidance

MimiAgent assembles instructions from distinct ownership layers:

- runtime and Host invariants;
- user-level `MIMI.md` identity and `PREFERENCES.md` behavior;
- hierarchical project guidance such as `AGENTS.md` or `CLAUDE.md`;
- activated Skills;
- relevant Goal, Plan, checkpoint, and Memory context.

Instruction order does not imply authorization. None of these documents can add tools, expand event trust, or override the effective capability policy.

MemoryHub separates evidence, compiled semantic pages, and rebuildable indexes. Private and workspace scopes remain distinct. Suppression and provenance receipts survive reindexing. External claims cannot directly become active private memory without the policy and maintenance gates.

## Extension Boundaries

Use the smallest suitable extension point:

| Need | Preferred mechanism |
| --- | --- |
| Repeatable instructions, scripts, and resources | Agent Skill |
| Tools or resources already exposed by another service | MCP |
| Durable events, channel delivery, or credentialed external actions | Isolated Connector |
| Generic high-frequency local capability | Built-in tool, after policy review |

Connector channel SDKs and credentials stay outside the runtime in isolated processes. The built-in Connector protocol is NDJSON with explicit delivery acknowledgement and an action bridge. See [CONNECTORS.md](./CONNECTORS.md).

## State Integrity

Persistent JSON state uses validated atomic stores: lock shared mutations, reread while holding the lock, validate the next value, write a unique temporary file, and replace atomically. Corruption is isolated rather than accepted as empty state.

Future state versions fail closed and remain untouched. An older binary must not relabel an unsupported future version as corruption or silently migrate it backward.

SQLite domains define transaction ownership explicitly. Event completion and outbox creation share a transaction; delivery is independently retryable.

## Public Package Boundary

Only two package entry points are supported:

- `mimi-agent`
- `mimi-agent/orchestration`

Deep imports from `dist/` or `src/` are internal. Runtime and TypeScript exports are locked by a versioned contract and verified again from the packed tarball. See [PUBLIC_API.md](./PUBLIC_API.md).

## Verification

Architecture-sensitive changes should run:

```bash
npm run check:repo
npm run check
npm test
npm run build
```

Changes to packaging or public entry points also run `npm run test:package`. Retrieval changes add `npm run eval`; provider behavior adds the offline provider contract. Real-provider and macOS UI evaluations remain explicit opt-in checks.

## Deliberate Non-Goals

The core does not aim to provide a hosted web UI, multi-tenant isolation, a distributed queue, arbitrary-depth agent graphs, a general workflow DSL, an enterprise vector database, or a container orchestration platform.

These boundaries keep the local runtime auditable. Capabilities outside them should normally live in an MCP server, Skill, Connector, or external system.
