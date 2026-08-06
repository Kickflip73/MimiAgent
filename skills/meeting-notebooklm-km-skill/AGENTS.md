# meeting-notebooklm-km-skill

## Purpose

Run a cross-platform, headless meeting workflow: collect authorized meeting sources, submit them to Google NotebookLM through the pinned API client, extract source-grounded decisions/actions/risks/knowledge, and optionally publish the verified Markdown to Meituan 学城 through official Citadel tooling.

## Activation

Use this Skill for `/meeting-notebooklm-km-skill` and natural-language requests involving NotebookLM meeting summaries, meeting-material extraction, or NotebookLM-to-学城 publication.

## Runtime contract

- Read `SKILL.md` for the full workflow.
- Do not use Computer Use or browser automation for routine NotebookLM operations.
- Do not depend on a machine-specific VPN/proxy application or local browser profile.
- Require `doctor` to return `status: ready` before upload.
- Authentication is provided as a host-mounted secret through `NOTEBOOKLM_STORAGE_STATE`.
- Network routing is direct or supplied through standard proxy environment variables / explicit `NOTEBOOKLM_PROXY`.
- Treat the NotebookLM client as unofficial and fail closed on upstream API drift.
- Publish to 学城 only through official `oa-skills citadel`; verify the returned content ID and re-read the document.

## Entry point

```bash
node scripts/meeting_notebooklm.mjs --help
```

See `references/setup.md` for one-time authentication and fleet deployment, and `references/network.md` for portable egress configuration.
