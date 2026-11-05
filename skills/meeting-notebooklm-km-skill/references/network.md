# Portable network contract

This Skill has no dependency on a personal VPN application, a browser profile, a particular operating system, or any local GUI. NotebookLM network access is the responsibility of the agent runtime.

## Direct access

If `https://notebooklm.google.com/` is reachable from the agent's approved egress region, no proxy variable is required:

```bash
node scripts/meeting_notebooklm.mjs doctor
```

## Standard proxy access

If the deployment requires an outbound proxy, inject standard variables from the host:

```bash
export HTTP_PROXY=https://proxy.example.internal:8443
export HTTPS_PROXY=https://proxy.example.internal:8443
export ALL_PROXY=https://proxy.example.internal:8443
export NODE_USE_ENV_PROXY=1
```

Or set a per-Skill endpoint:

```bash
export NOTEBOOKLM_PROXY=https://proxy.example.internal:8443
```

`NOTEBOOKLM_PROXY` must be an explicit `http://` or `https://` URL with a port. The runner never auto-discovers local applications and never changes system network settings.

Proxy credentials are secrets. Inject them through the runtime secret store; do not place them in `SKILL.md`, shell history, source control, or model prompts.

## Headless and multi-agent deployment

Recommended deployment:

```text
Agent runtimes
  ├─ read-only NotebookLM auth-state secret
  ├─ approved HTTP(S) egress proxy, if needed
  └─ Skill + Node.js
             ↓
       Google NotebookLM
```

For larger fleets, put the runner behind an internal authenticated gateway. The gateway owns:

- NotebookLM authentication state;
- approved egress and region policy;
- per-user authorization;
- upload classification and size limits;
- account serialization/rate limits;
- notebook retention/deletion policy;
- audit records that exclude cookies and document bodies.

Downstream agents submit sources and extraction requirements but never receive raw Google cookies.

## Reachability checks

Before upload, `doctor` checks:

1. auth state exists and contains live Google/NotebookLM cookies;
2. an explicit proxy is reachable when configured;
3. `https://notebooklm.google.com/` is reachable;
4. the NotebookLM provider can perform an authenticated list operation.

A redirect to Google Accounts proves network reachability only; it does not prove authenticated API access.

## Failure classification

| Symptom | Classification | Action |
|---|---|---|
| explicit proxy refuses connection | `proxy_unreachable` | fix the runtime-managed proxy; do not launch a GUI proxy app |
| NotebookLM reports unsupported location | `region_unsupported` | use an approved supported egress; do not rotate locations blindly |
| auth file missing | `auth_missing` | mount the configured auth secret or run setup on an interactive workstation |
| provider list call fails after login | `auth_expired` | renew the auth state through approved setup |
| RPC/decoder shape errors after prior success | `upstream_changed` | update and revalidate the pinned provider; do not fall back to Computer Use |
| HTTP 429 | `rate_limited` | back off and serialize account use |
| CAPTCHA/MFA/consent | `requires_user_auth` | stop; an authorized human completes setup |

## Compliance

Network reachability is not upload authorization. Before sending meeting material to Google, apply the data-classification and authorization rules in `SKILL.md`.
