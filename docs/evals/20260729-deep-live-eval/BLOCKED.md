# Blocked routes

## BLK-009 — Evaluated Daemon exited before SUP2 could start

- Status: terminal for this unattended evaluation under the frozen no-restart boundary.
- Three independent read-only confirmations returned `状态 ○ 未运行`; `~/.mimi-agent/daemon/mimi.sock` and former PID 85227 are absent.
- Immediately preceding durable state: internal `memory_maintenance` Task `33e4e953-8b0b-41b8-aa15-edad50306db1`, Run `df61d697-eb39-4ee6-bcbf-e2c5e8a57f19`, completed normally at `2026-07-29T15:00:01.635Z`. The temporal adjacency is evidence, but it does not prove maintenance caused the exit.
- Daemon stdout/stderr remained at 8,184/878,883 bytes and contain no exit record. The missing lifecycle receipt is itself a diagnosability gap.
- A direct SQLite open stopped working after the socket disappeared; immutable read-only mode recovered the final committed snapshot. No database file was copied or changed.
- Affected frozen scenarios: Y01–Y12. Zero SUP2 prompts were submitted, so they are `blocked`, not failed or passed.
- Actions deliberately not taken: restart, install/link, Provider/config/budget change, one-shot command that might auto-start or reconcile the Daemon.
- Reproducible recovery gate after an externally authorized restore:

```bash
cd /Users/liuyuran/Project/MimiAgent
command -v mimi
mimi --version
mimi daemon status
sqlite3 -readonly -json ~/.mimi-agent/daemon/mimi.db \
  "select (select count(*) from tasks where status='running') activeTasks,
          (select count(*) from runs where status='running') activeRuns,
          (select count(*) from outbox where status in ('pending','sending')) outboxActive;"
shasum -a 256 /Users/liuyuran/.codex/worktrees/ba36/MimiAgent/docs/evals/20260729-deep-live-eval/SUPPLEMENT2_SCENARIOS.json
```

Expected frozen SUP2 hash: `53c138805c833854cf45296dbb703d2b1b4bb2f9a5183b09fa1cc54896ae42f7`.

## Final disposition

- The evaluation is no longer waiting on a Run gate: 30/30 real Runs finished.
- BLK-001 and the later Token-budget block were evaluator mistakes. Installed runtime source showed that the Token threshold is diagnostic for authenticated Owner CLI commands; no budget or configuration change was required.
- BLK-007 cleared naturally when the unrelated Owner Task finished. It was not cancelled or preempted.
- BLK-002 remains a static-suite prerequisite block: `tsc/tsx` were absent and were not installed.
- BLK-003 permanently consumed U01/U02, so S15/S16 were skipped to preserve the 30-Run cap. Their capability coverage remains unknown, not passed.
- Product-level blocked routes remain in `ISSUES.md`: Browser public read, Safe Desktop invocation, Goal→Plan continuation, and non-ready CI/Doctor state.

## BLK-008 — Frozen completion matrix cannot be completed inside the exhausted Run cap

- Status: blocked after the same acceptance conflict was confirmed unchanged on three consecutive active-Goal completion audits.
- Hard facts:
  - 30/30 real Run slots are consumed.
  - S15/S16 were skipped, leaving Skill/Tool availability at 0/2.
  - Task 3 required Safe, Workstation and Full Owner positive/negative injection samples; no Workstation injection pair ran.
  - S10 executed a semantically similar but non-exact prompt, so R03 is the first execution of frozen S10 wording rather than an exact repeat.
  - Goal/Plan was sampled, but the explicit cancel/resume path was not.
- Why it is not repaired in this Goal: adding Runs would violate the frozen maximum of 30; rewriting historical prompts/outcomes would falsify evidence.
- Required external change: Owner authorization for a separately frozen follow-up evaluation cycle with a new Run cap and explicit scenarios for the four missing coverage areas. The existing 30-Run evidence remains immutable.
- Reproducible audit:

```bash
cd /Users/liuyuran/.codex/worktrees/ba36/MimiAgent
shasum -a 256 docs/evals/20260729-deep-live-eval/SCENARIOS.json
node -e '
const fs=require("fs");
const p="docs/evals/20260729-deep-live-eval/EVIDENCE.jsonl";
const rows=fs.readFileSync(p,"utf8").trim().split("\n").map(JSON.parse);
console.log(rows.filter(x=>x.kind==="live_run").map(x=>x.evalRunId));
'
```

- Only a separately authorized new evaluation cycle with a new freeze/cap can fill the missing samples. This document does not authorize that cycle.

## BLK-001 — Initial live-run gate

- Status: waiting, not a scenario result.
- Observed: 2 active Events, 2 running Tasks, 0 pending/sending Outbox, 0 Host mutations.
- Budget: 22/20 runs in the last hour; 70/100 runs today.
- Safe retry:

```bash
mimi daemon status --json
```

- Rule: do not submit a live scenario until hourly/daily budget and active-work gates allow it. Three consecutive observations with the same blocking cause promote the affected scenario to `blocked`; they do not authorize bypassing the gate.

## BLK-002 — Static suites cannot load dependencies

- Status: terminal for this evaluation unless dependencies appear without our intervention.
- Commands:

```bash
npm run ci
npm run eval:m1
npm run eval:security
```

- Actual: `tsc` and `tsx` are absent in this worktree. The Security runner reports two loader failures and zero passing tests.
- Constraint: this Goal forbids dependency installation and lock/dependency changes.
- Classification: static-baseline environment prerequisite failure; it is not a live-run result and not a code-regression claim.

## BLK-003 — One-shot slash commands bypassed the interactive command path

- Status: protocol deviation with two real Runs consumed; not replayed.
- Trigger: `mimi "/tools"` and `mimi "/status"` were submitted as one-shot tasks while collecting catalog evidence.
- Actual: both inputs became model Runs instead of interactive `CommandHandler` operations.
- Evidence: Task IDs `ff7e32af-64c4-4f64-9ae4-d6db5aef0934` and `9d6cd451-1730-46f4-a09c-8d7dc3db95b7`.
- Containment: count both against the 30-Run maximum, preserve their real outcomes, skip frozen S15/S16, and use PTY slash commands only for future non-model controls.

## BLK-004 — Global CLI and Daemon changed after scenario freeze

- Initial observation: `command -v mimi` resolved through the main workspace build.
- Filesystem evidence: frozen `SCENARIOS.json` birth epoch `1785318900`; global package/bin birth epochs `1785318944/1785318945`.
- Current client build: `0.12.0+a491f6d0019b`; Daemon PID 98385 started at `2026-07-29T09:56:21.264Z` with the same build.
- Constraint: no install, link, restart, or Daemon replacement is authorized in this Goal.
- Containment: split evidence into B0 (initial old Daemon) and B1 (new coherent CLI/Daemon), do not compare them as one version, and re-check package/Daemon identity before every future live batch.

## BLK-005 — Current daily Token budget already exceeded

- Observation at `2026-07-29T18:25:53+08:00`: 76 Runs, 90,936,181 input + 336,949 output = 91,273,130 total tokens.
- Resource alert: `tokens_budget_exceeded`.
- Current source budget: `src/daemon/resource-slo.ts:40-43` defines 100 Runs and 2,000,000 tokens per local day.
- Constraint: the Goal forbids increasing or bypassing existing budgets.
- Decision: submit no scheduled scenario before the Asia/Shanghai daily reset. After reset, monitor both Run and Token totals after every small batch.
- Safe retry:

```bash
mimi daemon activity 1
mimi daemon status --json
```

## BLK-006 — Goal paused at the external daily-reset boundary

Status: **superseded evaluator error** at `2026-07-29T19:20:24+08:00`.

The Token resource threshold is an activity/Doctor alert, not a scheduling gate. Installed runtime source also proves authenticated Owner CLI commands are admitted before autonomy Run budgets. No budget or configuration change was required; the Goal resumed when the ordinary Event/Task/Outbox/Host mutation gate became idle. The historical observations below are retained to make the mistake auditable.

- Strict blocked audit: the same daily Token-budget cause remained present for five consecutive Goal turns.
- Final pre-block observation: `2026-07-29T18:45:41+08:00`.
- Conflict gates: 0 active Events, 0 running Tasks, 0 pending/sending Outbox, 0 Host mutations.
- Hour gates had recovered to 11 Runs/hour and 8 local-CLI command Events/hour.
- Daily gate had not recovered: 76 Runs and 91,273,130 tokens against the existing 2,000,000-token resource budget.
- Progress at block: 2/30 real Runs; the 28 remaining Runs were not submitted.
- Required external change: Asia/Shanghai local-day reset. No configuration, budget, Provider, Daemon, or acceptance threshold change is authorized.
- Resume procedure:

```bash
date '+%Y-%m-%dT%H:%M:%S%z'
command -v mimi
mimi --version
mimi daemon status --json
mimi daemon activity 1
```

Only resume scheduled scenarios after the build cohort is recorded again and Event/Task/Outbox/Host, hourly, daily, per-source, and Token gates are all green.

## BLK-007 — R04 preflight deferred by unrelated active Owner Task

- Status: temporary preflight block; no Mimi Run was submitted and the 27/30 counter did not change.
- First observed after R03: Task `d4b8a43d-ecf5-4391-beae-fd94c631cb5a`, Session `mimi-chat-57d1f747-67af-4b27-9b0e-d6ff403fc8bc`, status `running`.
- The same Task remained running through more than three consecutive read-only checks. Its objective/body was not inspected or copied.
- Containment: do not overlap R04-R06 with another owner task, do not cancel/preempt it, and do not bypass the Daemon.
- Machine-safe readiness check:

```bash
sqlite3 -readonly -json /Users/liuyuran/.mimi-agent/daemon/mimi.db \
  "select id,session_key,status,updated_at from tasks where status='running';"
```

- R04 replay command after the query returns `[]`:

```bash
cd /Users/liuyuran/Project/MimiAgent
script -q tmp/mimi-live-eval-20260729/transcripts/R04.typescript \
  env MIMI_SESSION=eval-20260729-s11 mimi
```

Then status-verify Full Owner in that PTY and submit the frozen R04 prompt exactly once.
