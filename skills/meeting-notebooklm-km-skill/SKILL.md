---
name: meeting-notebooklm-km-skill
description: Collect recent meeting notes or user-specified source files, submit them to Google NotebookLM without Computer Use, extract decisions/actions/risks/insights under a requested rubric, and optionally publish the verified result to Meituan 学城/KM. Trigger on requests such as 用 NotebookLM 整理会议纪要, Gemini Notebook 总结会议, 收集最近会议材料并提炼, 把会议内容整理后发学城, or meeting-to-NotebookLM-to-KM workflows.
license: MIT
metadata:
  version: 0.2.0
  portability: cross-platform-headless
---

# Meeting → NotebookLM → 学城

Use this workflow to turn raw meeting materials into a source-grounded deliverable. The normal runtime is shell/API only. Do not use Computer Use, raw browser clicking, or guessed Google endpoints.

## Non-negotiable boundaries

- Treat “Gemini Notebook” as **Google NotebookLM** unless the user names a different product.
- The NotebookLM integration uses an **unofficial client over undocumented Google APIs**. Say so when first enabling it for a user or environment. It may break when Google changes the service.
- The Skill is cross-platform and must not depend on a personal browser profile, a machine-specific path, Computer Use, or any locally installed GUI proxy. Network routing comes only from standard environment variables or an explicit `NOTEBOOKLM_PROXY` URL supplied by the runtime.
- Never upload confidential, restricted, personal, or regulated material unless the owner has authorized that external transfer and policy permits it. A request to process a clearly identified file is upload authorization for that file, not blanket authorization for unrelated nearby files.
- Authentication is one-time and interactive. Routine runs are headless and silent after a storage-state file exists. Never ask an agent to collect, paste, print, or commit Google cookies.
- Proxy configuration solves network reachability, not authentication. Do not bypass access controls, CAPTCHAs, organization policy, or regional terms.
- Do not claim NotebookLM processed a source unless the workflow receipt reports a notebook ID, source ID(s), and a non-empty answer.
- Publishing to 学城 is a separate external write. Only report success when Citadel returns a numeric `contentId` and URL, then re-read the document.

## Prerequisites

Required commands:

```bash
node --version        # Node 18+
npx --version
```

For 学城 publishing:

```bash
command -v oa-skills
oa-skills citadel listTools --mis <mis>
```

NotebookLM auth defaults to `~/.notebooklm/storage-state.json`. A maintainer may override it with `NOTEBOOKLM_STORAGE_STATE`. Agents serving an interactive owner should normally use `run --auto-setup`: the Agent launches the temporary login window and the owner only completes Google login in that window. Headless fleet agents receive a read-only auth secret from their host. See [setup.md](references/setup.md) for authentication and [network.md](references/network.md) for portable network configuration.

## Workflow

### 1. Resolve the source set

Prefer explicit user-provided paths or URLs. If the user asks for “最近一次会议记录” and gives no source:

1. Search only the current authorized workspace and explicit meeting-material roots.
2. Rank candidates by meeting semantics plus modification time. Typical terms: `会议`, `纪要`, `meeting`, `minutes`, `transcript`, `录音转写`.
3. Preview the leading candidates before choosing. File modification time alone is not proof that a document is a meeting record.
4. Use the smallest coherent source set. Do not sweep unrelated documents into the upload.
5. Record every chosen source path in the receipt.

Supported local text-oriented inputs include Markdown, text, PDF, DOCX, and common audio files accepted by the installed NotebookLM client. For multiple files, preserve each file as a separate NotebookLM source so citations remain meaningful.

### 2. Define the extraction contract

Use the user's requested rubric. If none is provided, use [meeting-extraction-prompt.md](assets/meeting-extraction-prompt.md).

The default contract requires:

- core conclusions and explicit decisions;
- actions with owner, date, dependency, and current ambiguity;
- risks, disagreements, and unresolved questions;
- reusable principles or domain knowledge;
- product/engineering follow-ups;
- a strict split between source facts and model inference.

Never invent an owner or deadline. Output `未明确` when the source does not identify one. Treat old dates as historical commitments, not automatically active commitments.

### 3. Run NotebookLM headlessly

For normal interactive-owner use, run with `--auto-setup`. If authentication is missing or expired, the Agent starts the login window itself, waits for the owner to finish Google login, saves the credential, closes the temporary login browser, and resumes the original workflow. The owner must not be asked to type a setup command or press Enter in a terminal.

```bash
node scripts/meeting_notebooklm.mjs run \
  --auto-setup \
  --title "<notebook title>" \
  --source /absolute/path/to/meeting.md \
  --prompt-file assets/meeting-extraction-prompt.md \
  --output /absolute/path/to/notebooklm-result.md \
  --receipt /absolute/path/to/notebooklm-receipt.json
```

Multiple `--source` flags are allowed. The runner:

1. validates authentication and network reachability;
2. creates a NotebookLM notebook;
3. uploads each source;
4. asks the extraction question;
5. writes Markdown plus a machine-readable receipt;
6. optionally deletes the temporary notebook when `--cleanup` is passed.

The default is to keep the notebook, because deletion is irreversible and users often want to continue asking questions. Use `--cleanup` only when the owner explicitly requests deletion or an approved retention policy requires it.

For a preflight with no upload:

```bash
node scripts/meeting_notebooklm.mjs doctor
```

### 4. Verify the NotebookLM deliverable

Before publishing, verify:

- receipt status is `completed`;
- notebook ID and all source IDs are present;
- answer is non-empty;
- required sections appear;
- source filenames match the intended files;
- owners, dates, and commitments are marked `未明确` when unsupported;
- facts and AI suggestions are visibly separated.

The runner preserves NotebookLM citation markers when returned. Do not manufacture citation numbers or claim paragraph-level citations if the client did not return them.

### 5. Prepare a publication document

Add a short provenance note at the top:

- original source names and dates;
- that NotebookLM generated the first extraction;
- that facts and model suggestions are separated;
- that historical owners/dates require current confirmation.

Use a clear title and keep substantial content in a local Markdown file. Do not put a large document in a shell argument.

### 6. Publish through official Citadel only

Load the `meituan-km` Skill and follow its current contract. Minimum flow:

```bash
command -v oa-skills
oa-skills citadel listTools --mis <mis>
oa-skills citadel createDocument \
  --mis <mis> \
  --title "<title>" \
  --file /absolute/path/to/result.md \
  --raw
```

Do not set `--parentId` or `--spaceId` unless the user explicitly specified a location.

Require the creation receipt to include both:

- numeric `contentId`;
- `https://km.sankuai.com/collabpage/<contentId>`.

Then re-read:

```bash
oa-skills citadel getMarkdown --mis <mis> --contentId <contentId> --raw
```

Check the title, major headings, action table, and final fact/inference section. A zero exit code without ID/link or without successful re-read is not verified publication.

## Network routing

The Skill contains no region-specific or machine-specific proxy integration. In an environment where NotebookLM is directly reachable, no proxy configuration is needed. Otherwise, the agent host must inject an approved standard proxy:

```bash
HTTP_PROXY=https://proxy.example.internal:8443
HTTPS_PROXY=https://proxy.example.internal:8443
ALL_PROXY=https://proxy.example.internal:8443
NODE_USE_ENV_PROXY=1
```

Alternatively, pass the same endpoint explicitly to the runner:

```bash
NOTEBOOKLM_PROXY=https://proxy.example.internal:8443
```

Do not put proxy credentials in the Skill or command history; inject them from the host secret store. The Skill does **not** launch a VPN/proxy application, alter system network settings, or use Computer Use. This makes it portable across macOS, Linux, Windows/WSL, containers, and headless agents.

Preferred production arrangement for many agents:

1. run a centrally managed outbound proxy/egress route;
2. inject proxy variables and a read-only NotebookLM auth state into each authorized agent runtime;
3. keep credentials in the host secret store, never inside the Skill;
4. serialize writes to one Google account to avoid rate and session conflicts.

See [network.md](references/network.md) for failure classification.

## Failure handling

- `auth_missing`: run one-time setup; do not retry business actions.
- `auth_expired`: refresh auth once through the approved setup process; do not scrape cookies.
- `proxy_unreachable`: report the proxy endpoint and stop before creating a notebook.
- `region_unsupported`: verify the approved proxy is active. Do not blindly rotate countries or bypass policy.
- `source_rejected`: report the exact file and accepted types; do not silently convert sensitive files through a third party.
- `upstream_changed`: the unofficial API likely drifted. Stop and update the adapter; do not switch to Computer Use.
- uncertain create/upload/ask: inspect the receipt and notebook list before retrying. Never duplicate a notebook or publication blindly.
- Citadel failure: preserve the local Markdown and NotebookLM receipt; do not claim publication.

## Output contract

Final response should state only verified outcomes:

- chosen source files;
- NotebookLM notebook ID/URL if retained;
- extraction artifact path;
- key caveats such as historical dates or model inference;
- 学城 content ID and verified URL if published;
- any skipped or failed stage.

## Resources

- [setup.md](references/setup.md): one-time auth and shared-runtime deployment
- [network.md](references/network.md): portable direct/proxy egress and production deployment
- [meeting-extraction-prompt.md](assets/meeting-extraction-prompt.md): default extraction rubric
- `scripts/meeting_notebooklm.mjs`: headless NotebookLM runner
- `tests/meeting_notebooklm.test.mjs`: local unit tests with a fake provider
