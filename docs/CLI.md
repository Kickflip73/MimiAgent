<p align="center">
  <strong>English</strong> | <a href="./zh-CN/CLI.md">简体中文</a>
</p>

# CLI and Daemon Reference

The `mimi` executable is both the interactive client and the local daemon administration command. Run `mimi --help`, `/help`, and `mimi daemon --help` for the exact command set shipped by the installed version.

## Top-Level Commands

| Command | Purpose |
| --- | --- |
| `mimi` | Open the interactive terminal. The shared daemon starts automatically when needed. |
| `mimi "task"` | Submit a one-shot task and stream its result. |
| `mimi --help` | Show top-level usage. |
| `mimi --version` | Print the installed version. |
| `mimi provider list` | List the model registry and current global default. |
| `mimi provider add <provider/model> ...` | Register a provider target and capabilities. |
| `mimi provider set <provider/model>` | Change the registry global default for the next Run. |
| `mimi provider test <provider/model>` | Test a registered target. |
| `mimi daemon --help` | Show daemon administration commands. |

Provider examples and option semantics are documented in [Configuration](./CONFIGURATION.md).

## Interactive Slash Commands

### Runtime and models

| Command | Purpose |
| --- | --- |
| `/status` | Show model, session, runtime, and extension status. |
| `/security [profile]` | Show the immutable startup security profile; runtime mutation requests are rejected. |
| `/models` | List exact model targets, capabilities, and configuration status. |
| `/model` | Inspect or select a model target. |
| `/model current` | Show the current target. |
| `/model inspect <target>` | Inspect one target. |
| `/model use <target>` | Pin the current session to a target. |
| `/model auto` | Clear the session pin and use routing. |
| `/model routes` | Show scenario routes. |
| `/model route <scenario> <target|auto>` | Set or clear a scenario route. |
| `/model doctor [target]` | Check target readiness. |
| `/mode [name]` | Inspect or change General, Plan, or Ultra mode. |
| `/output [level]` | Change terminal detail level. |
| `/tools` | List tools currently available to the Run. |

Model and mode changes apply at a safe Run boundary. The security profile changes only through startup configuration. Plan remains read-only regardless of that profile.

### Sessions and history

| Command | Purpose |
| --- | --- |
| `/new [id]` | Create and switch to a new session. |
| `/sessions` | Select a recent session. |
| `/switch <id>` | Switch by session ID. |
| `/history` | Show current canonical session history. |
| `/clear` | Clear the current session. |
| `/undo [run-id]` | List or preview file changes that can be safely reversed. |
| `/undo <run-id> --apply` | Explicitly apply the selected reversal. |
| `/retry` | Re-run the last input from this terminal process. |
| `/exit` | Close the current CLI. The daemon and accepted background tasks continue. |

### Context, instructions, and extensions

| Command | Purpose |
| --- | --- |
| `/context` | Show context, memory, plan, and request-budget information. |
| `/compact` | Archive older context while preserving recent complete turns. |
| `/instructions` | Show loaded Soul and project-guidance sources. |
| `/skills` | List discovered Skills and their source. |
| `/skills reload` | Rebuild the Skill registry. |
| `/skills active` | Show Skills activated in the current session. |
| `/skills deactivate <name>` | Deactivate a current session binding. |
| `/skills enable|disable <project|user> <name>` | Persist a project- or user-scope selection. |
| `/mcp` | Show MCP server state and tool counts. |
| `/mcp reload` | Reconnect configured MCP servers. |

### Memory, plans, and tasks

| Command | Purpose |
| --- | --- |
| `/memory status` | Show MemoryHub health. |
| `/memory list|search|read` | Inspect memory without changing it. |
| `/memory ingest|capture` | Compile a source or completed session round. |
| `/memory lint|conflicts|audit` | Inspect memory quality and provenance. |
| `/memory forget` | Remove a memory page and preserve suppression state. |
| `/memory reindex|maintain` | Rebuild derived indexes or run bounded maintenance. |
| `/plan` | Show the current multi-step plan. |
| `/team` | Show Ultra team tasks, dependencies, and results. |
| `/goal [objective]` | Show or set the persistent goal. |
| `/resume` | Start a new Run from Goal, Plan, Team, and checkpoint state. |
| `/tasks [limit]` | List recent background tasks. |
| `/task <id>` | Inspect one background task. |
| `/task pause <id>` | Request a safe pause. |
| `/task resume <id> [context]` | Resume a paused or blocked task. |
| `/task cancel <id> [reason]` | Request cancellation. |
| `/confirm-send <text>` | Confirm exact personal-message text in an eligible session. |

## Keyboard Controls

| Key | Action |
| --- | --- |
| `Esc` | Request cancellation of the current Run. |
| `Shift+Tab` | Cycle execution mode. |
| `Shift+Enter` | Insert a newline. |
| `Command+Left/Right` | Move to the beginning or end of the line on macOS terminals. |
| `Up/Down` | Navigate history or command choices. |
| `Tab` | Complete the current command. |
| `Enter` | Submit the current input. |

## Daemon Lifecycle and Health

| Command | Purpose |
| --- | --- |
| `mimi daemon start` | Initialize private state and start the service. |
| `mimi daemon stop` | Stop safely. |
| `mimi daemon restart [--force]` | Restart; `--force` still refuses unsafe in-flight side effects. |
| `mimi daemon status [--json]` | Show health in human-readable or structured form. |
| `mimi daemon doctor` | Run read-only readiness checks. |
| `mimi daemon diagnostics [file]` | Write a redacted diagnostic bundle. |

## Backup and Recovery

| Command | Purpose |
| --- | --- |
| `mimi daemon backup [directory]` | Create a recovery backup with hashes and SQLite integrity checks. |
| `mimi daemon backup verify <directory>` | Verify files, digests, and database integrity. |
| `mimi daemon restore <directory>` | Restore only while offline into an absent, empty data root. |

Always verify a backup before depending on it. Restore deliberately refuses to overwrite a live or populated data root.

## Queue Inspection and Recovery

| Command | Purpose |
| --- | --- |
| `mimi daemon activity [limit]` | Show backlog, failures, and recent activity. |
| `mimi daemon events|tasks|runs|outbox [limit]` | List one durable control-plane record type. |
| `mimi daemon show <type> <id>` | Show one event, task, run, outbox item, or schedule. |
| `mimi daemon retry task <id>` | Requeue a dead-letter task. |
| `mimi daemon retry outbox <id>` | Retry delivery; duplicate delivery may be possible. |
| `mimi daemon archive outbox <id>` | Archive a failed delivery. |

Do not retry a record until its external side-effect state is understood. MimiAgent does not silently replay uncertain shell, file, MCP, connector, or network transactions.

## Connectors, Attention, and Schedules

| Command | Purpose |
| --- | --- |
| `mimi daemon connectors [reload]` | Show or reload connector state and capabilities. |
| `mimi daemon connectors enable|disable <id>` | Atomically change an existing connector's enabled state. |
| `mimi daemon probe <profile>` | Run an authenticated fixed read-only readiness probe. |
| `mimi daemon attention [reload]` | Show or reload attention policy. |
| `mimi daemon digest [limit]` | Show pending digest entries. |
| `mimi daemon brief` | Generate a proactive briefing immediately. |
| `mimi daemon schedule list` | List schedules. |
| `mimi daemon schedule at <ISO-time> "task"` | Create a one-time schedule. |
| `mimi daemon schedule every <10m|1h> "task"` | Create a recurring schedule. |
| `mimi daemon schedule remove <id>` | Remove a schedule. |

Detailed event and action contracts are in [Attention](./ATTENTION.md) and [Connectors](./CONNECTORS.md).
