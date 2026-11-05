# Integrated development branch

Use `codex/development-integrated` as the shared development baseline. Branch names and commit dates alone do not indicate which features a build contains: the Breeze feature branch and `main` had diverged.

## Integration inventory — 2026-11-05

| Source | Disposition |
| --- | --- |
| `feat/breeze-tts` / `origin/feat/breeze-tts` (`2e076a2`) | Baseline; preserves Breeze TTS and release/installation fixes. |
| Local `main` (`3a1758c`) | Merged, including `fix/web-ux-session-flow` and `fix/capability-existence-verification`: composer focus, immediate session-list reconciliation, navigation/workspace presentation, capability verification and the complete Skill index. |
| Local Web changes from this session | Committed: exact local hostname and public-port configuration, loopback-only access, same-origin checks and cryptographic UUID generation compatible with HTTP domains. |
| Existing `codex/mimiagent-integrated` worktree changes | Retained already-integrated runtime/media/TTS work; recovered outstanding Computer launch/window verification and missing context, provider, file-diagnostic and Web regression tests. |
| Existing `codex/mimiagent-web` worktree changes | Compared against subsequent Web, cron, model, daemon and atomic-state implementations; retain the newer integrated versions, including cancellation, media and session isolation fixes. |
| Existing `codex/m3-multimodal-benchmark-hardening` worktree changes | Speech language routing and selectable voices are already represented by the later integrated speech implementation and tests. Retain the newer durable-render and Breeze implementation. |
| Existing `codex/m2-memory-hub` worktree addition | Recover `meeting-notebooklm-km-skill` as an experimental, unpublished Skill with its offline tests. |
| Other local feature branches and fetched remote branches | Already ancestors of the integrated main/Breeze history. |

The older M3 branch predates the sanitized public baseline (`4bcee0e`). Its runtime fixes were carried forward through that baseline and subsequent commits, including `9fa86d4`, `d7d6658`, `8de6efe`, `d968030`, `213ba97`, `423c591` and `e487231`. Do not merge its entire historical tree back: that would resurrect removed private evaluation evidence and superseded runtime paths.

Preserve old worktrees and stashes as source/history; do not reset or delete them as part of integration. Exclude generated caches, personal runtime knowledge, credentials, session data and deployment evidence. Preserve the English architecture overview because the bilingual README and documentation index still link to it.

## Build and deployment

Before building, verify the active branch and working-tree status. Run `npm run ci` in a clean checkout; local ignored runtime knowledge can intentionally trip the asset-boundary check in a long-lived workspace. Run the experimental Skill's offline tests separately:

```bash
node --test skills/meeting-notebooklm-km-skill/tests/meeting_notebooklm.test.mjs
```

Use `dist/build-identity.json` to identify the compiled revision. A running daemon retains its loaded code until restarted; rebuilding the Web server alone does not update the daemon. Check the runtime's reported build identity before calling a deployment current.

Local domain setup is machine configuration, not repository state. `MIMI_WEB_HOSTNAME=mimi.com` and `MIMI_WEB_PUBLIC_PORT=80` accept `http://mimi.com/` behind a loopback reverse proxy preserving Host and Origin; hosts mapping and the proxy must also exist. See [CLI](./CLI.md).
