# Execution reliability after real-use evaluation

## Problem and goal

Real daily-use evaluations exposed a shared failure chain: large tool results lost critical fields before the model consumed them; recovery returned another lossy summary; discovery confused Skill names with tool names; invalid arguments hid the violated constraints; and task completion disagreed with the Host's business outcome. Repeated discovery, guessing and model round trips followed.

The goal is a reliable, inspectable execution loop with existing components. No new workflow engine, vector database, task subsystem, distributed rate limiter, or scenario-specific prompt rules are introduced.

## Design

1. **Bounded original evidence, not heuristic substitutes.** The existing ContextManager preserves small/medium current-task outputs. Very large outputs require a validated Session artifact before replacement with an explicit original-text page. The page includes stable identity, total length and next offset. Recovery uses the same Session/run/digest ownership checks. It must not feed recovered pages back into a lossy sentence extractor.
2. **Two context budgets.** The model's hard input budget remains a correctness boundary. A 64K-token soft working-set threshold triggers semantic summarization without forcing destructive trimming. A single user turn may compact a prefix of complete tool groups while retaining the user request, recent complete groups and pending call/result protocol units. Summaries preserve constraints, unfinished work, evidence references and side-effect state; canonical transcripts and ledgers remain authoritative. Cancellation, timeout and no-gain/failure paths must be bounded and observable.
3. **One capability contract.** Skill instance discovery routes to the authorized Skill catalog; default catalog output is paged metadata rather than entire instructions. Execution access is computed by the Host from active, current, enabled Skill bindings. A validated Skill directory can be read by an otherwise authorized Shell without granting access to sibling private state or permitting writes to private Skills. Symlink escapes remain denied. Context-consuming background policies also permit bounded artifact recovery. MCP creation reads configuration only; explicit MCP discovery connects services once per runtime and materializes authorized tools in the existing registry. Concurrent discovery shares one connection attempt; failed services can retry, closed managers cannot reconnect. Worker credentials stay in a private manager-owned environment until close.
4. **Actionable errors at the shared tool adapter.** Preserve parser validation issues through SDK and execution-ledger boundaries. Return field paths and constraints, without rejected values or secrets. Add constraints to model-visible descriptions where the provider's strict schema conversion drops them. Keep actual parsers strict. Mark validation rejected before execution distinctly from execution failure or uncertainty.
5. **Honest outcomes and bounded recovery.** Transport completion is not business completion. Shell exit codes and structured tool failures influence status projection. A later success only resolves a pre-dispatch validation issue when the business arguments outside the rejected fields still match. Durable task completion respects Host finalization; partial/blocked/interrupted outcomes retain results and wait for explicit continuation. Unknown side effects cannot be retried merely to make status green.
6. **Provider cooldown is a recoverable condition.** Treat 429 and circuit cooldown as transient with a not-before time, preserving Retry-After and existing finite attempt limits. User cancellation does not poison provider health. Do not silently switch models or replay uncertain actions.
7. **Small control/read path.** Next-turn model/mode/output preferences persist outside the long-running Session lane, and are applied when the next run freezes its scope. Context composition snapshots persist separately as small derived diagnostics; malformed/missing diagnostics never repair canonical state or block answers. Task lists omit full results; details stay on the detail endpoint. Healthy SSE replaces redundant recovery polling, with a stale/disconnected fallback.
8. **Timing before further performance surgery.** Record preparation, first-answer, stream, commit and total times in existing trace storage. These spans separate observed local stages; stream time includes provider/tool iterations and is not labeled pure model time. Do not delete the commit journal or bypass durable commit to obtain a faster benchmark.

## Compatibility and boundaries

- Existing transcripts, completion receipts, atomic stores and side-effect fencing remain the authority.
- Existing public task statuses are reused. No storage migration is required merely to introduce another success vocabulary.
- Preferences selected during a run affect the next run, not its frozen tool/security scope.
- Diagnostics contain composition counts and identifiers, not prompt or credential bodies.
- Missing historical reasoning cannot be reconstructed. Timing samples do not imply a global latency guarantee.
- Global journal partitioning, shared-account rate coordination and multi-day sleep/restart reliability require further evidence; this patch does not replace those systems speculatively.

## Verification

Each contract has an isolated regression, including large JSON/text/path fidelity, multi-page recovery, single-turn semantic snapshots, malformed limits, corrected arguments with unchanged business intent, private Skill read/write/symlink boundaries, task finalization, cooldown and cancellation, active-run preference writes, restartable context metadata and bounded task-list projection.

After type checking, full tests and packaging, run serial live-provider tasks through Web/Daemon using synthetic isolated files: short question, meeting extraction, unseen CSV values, long-document facts, Skill discovery/application, tool validation recovery and cancellation. Inspect actual artifacts and durable run outcomes independently of the model's success wording. Never overlap two requests in the same Session unless explicitly testing interruption.

## Issues found during the live retest

The first live retest still exposed IPC stalls. A native process sample showed the daemon main thread inside synchronous SQLite `StatementSync.All`, scanning B-tree pages after a file-close callback. The timeline query selected a Session's latest runs without a Session index; the real database's query plan scanned `runs_started_at`. Add the idempotent `(session_key, started_at DESC, id DESC, task_id)` index for existing databases and use indexed candidate task IDs for workspace recovery. Regression tests assert the production query plan uses a Session search. No transcript deletion, timeout extension or new storage service is needed.

The research task also reproduced a Shell false rejection: `&#39;` inside a quoted sed argument matched the old background-process regex. A small isolated lexical ownership check distinguishes quoted data, escapes, redirects and nested executable Shell. This check is not a sandbox; process-group cleanup and existing permission boundaries remain mandatory.
