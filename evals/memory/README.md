# M2 Memory Eval

`npm run eval:memory` runs 60 checked-in, hand-authored natural questions in lexical and hybrid modes. The questions cover people, projects, commitments, time, source provenance, correction, conflict, expiration, source deletion, entity merging, embedding changes, Vec unavailability, and reindex recovery. Queries remain distinct after case and whitespace normalization; no case or spacing expansion is used.

The deterministic hybrid mode uses a fixture-independent character n-gram embedding to exercise text-to-vector persistence, vec0 KNN, and RRF in temporary test state. It is mechanism evidence only: it is not a semantic model and must not be reported as production embedding or real-provider evidence. Production acceptance is reported separately by the local embedding provider diagnostics and its redacted semantic-paraphrase probe.

`npm run eval:memory:local` is the production local-vector acceptance. It removes embedding API keys from both child processes, uses the runtime's default local provider, proves a lexical miss becomes a vec0/RRF hit, then starts a second process with networking disabled and enforces nonzero vector rows, `ready`/`hybrid`, warm p95 under 200 ms, and RSS growth under 300 MiB. It creates only temporary synthetic state and prints aggregate evidence. When the execution host blocks Node downloads, `MIMI_MEMORY_LOCAL_EVAL_MODEL_SEED` may name an already downloaded revision directory; the provider still validates every pinned asset before inference.

For a local owner-only read evaluation, point `MIMI_DATA_DIR` or `AGENT_DATA_DIR` at the existing runtime data root and run:

```bash
node --import tsx evals/memory/owner-private.ts --limit 100
```

The entry opens only the requested owner profile catalog; a workspace catalog is included only when `--workspace-root` explicitly identifies the current workspace. It derives eligible Session IDs from owner-trusted Memory provenance and otherwise falls back only to the canonical owner Session. It reads Session JSON with a finite, bounded parser instead of the state-recovery API, so corrupt input is counted rather than repaired or quarantined. Catalogs are opened as immutable read-only snapshots; realpath, main-file identity, and WAL state are checked before and after every retrieval window. An active or changing WAL is rejected rather than checkpointed, copied, or modified. Retrieval reuses `SqliteMemoryCatalog.search()` and therefore the production FTS/BM25, vec0 SQL KNN, and RRF path. A matching cached local model may supply query vectors with `allowDownload=false`; remote embedding is never used by this evaluator.

The output contains aggregate counts, controlled evidence types, source coverage, retrieval mode, p50/p95, and `auditStatus: complete | incomplete | no-data` only. An incomplete required owner snapshot exits with status 2. It never prints or persists questions, refs, contents, filenames, or local paths. Session history has no ground-truth labels, so the report is explicitly `unlabeled-retrieval-audit` with `qualityEligible=false`: a hit is `partial`, a miss is `evidence-insufficient`, and neither result contributes to the checked-in 60-question correctness gate.
