# Authentication and portable deployment

## Runtime model

Routine NotebookLM operations are HTTP/API-only and work in headless agents. Google login itself is not headless automation: initial login, MFA, CAPTCHA, consent, and periodic re-authentication require an authorized human on an interactive workstation.

The output is a Playwright-compatible storage-state JSON file. Default:

```text
~/.notebooklm/storage-state.json
```

Override it in any runtime:

```bash
export NOTEBOOKLM_STORAGE_STATE=/run/secrets/notebooklm-storage-state.json
```

## Create the auth state once

On an interactive workstation, the Agent should invoke the business command with `--auto-setup`. If authentication is missing, the runner installs its temporary Chromium if needed, opens the Google page, prints `waiting_for_user_login`, watches for successful NotebookLM login, saves the auth state, closes the login browser, and resumes the original job. The owner only interacts with the Google page; they do not type commands or press Enter in a terminal.

The standalone equivalent is:

```bash
node scripts/meeting_notebooklm.mjs setup \
  --auth ~/.notebooklm/storage-state.json
```

`setup` installs the provider's Playwright Chromium when needed, then opens the login flow. If Chromium is already managed by the deployment, pass `--skip-browser-install`.

If the workstation uses an approved proxy, inject standard proxy variables or pass an explicit endpoint:

```bash
node scripts/meeting_notebooklm.mjs setup \
  --auth ~/.notebooklm/storage-state.json \
  --proxy https://proxy.example.internal:8443
```

Complete Google login in the browser opened by the provider. Setup verifies the resulting state and sets mode `0600` where supported.

If setup is executed inside a truly headless environment, it returns `requires_user_auth`. That is expected. Run setup on an interactive workstation, then transfer the result through the organization's secret-management process.

Do not automate passwords, MFA, CAPTCHA, or consent. Do not copy cookies out of a personal Chrome database.

## Secret handling

The storage-state file contains Google session cookies. Treat it as a credential:

- never commit or package it with the Skill;
- never print it to logs or model context;
- store it in Vault, Kubernetes Secret, CI secret storage, or the host's equivalent;
- mount it read-only only for authorized jobs;
- use a dedicated organizational Google account when policy allows;
- revoke/rotate when membership or deployment changes;
- serialize use per account to reduce session and rate conflicts.

## Headless agent bootstrap

A deployer installs the Skill and Node.js, mounts the secret, and runs:

```bash
export NOTEBOOKLM_STORAGE_STATE=/run/secrets/notebooklm-storage-state.json
node scripts/meeting_notebooklm.mjs doctor
```

Expected result:

```json
{
  "status": "ready"
}
```

Only after `doctor` is ready should an agent create notebooks or upload sources.

## Internal gateway option

For many agents, the strongest architecture is a small internal service wrapping this runner:

- agents authenticate to the internal service;
- the service owns the NotebookLM auth state and egress;
- agents never see Google credentials;
- policy checks authorize each uploaded source;
- jobs return the same notebook/source/answer receipt contract;
- rate limiting and notebook retention are centralized.

This Skill can be adapted to call that gateway as another provider without changing the meeting extraction and 学城 publication stages.

## Provider status

The pinned package is `notebooklm@0.1.1`, an unofficial client for undocumented NotebookLM APIs. Production deployment must pin and contract-test upgrades:

```bash
export NOTEBOOKLM_PACKAGE=notebooklm@<validated-version>
```

If Google changes the upstream RPC, return `upstream_changed`; do not silently fall back to browser or Computer Use.
