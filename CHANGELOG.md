# Changelog

All notable changes to MimiAgent are documented here.

## Unreleased

- Documents and packages the bounded MLX residency and idle scalar keepalive patch for delayed speech startup; adds an incremental tempo-output regression. Consolidates current speech and Computer development for local deployment.

- Single-speaker Breeze long-form reading pins seed/reference across pieces, uses longer bounded passages and rejects unsupported servers or lost anchors instead of silently redesigning voices. Includes the independent MLX service patch and regressions.

- Speech startup now says it is preparing audio instead of implying that another request is occupying the service; the player has no queue-ownership signal at this stage.

- Speech waits for audible output to drain before closing, pads tempo-conversion tails, queues busy Breeze requests, and uses progress-based timeouts with bounded text pieces for full-length stories. Never automatically abbreviates a failed story or replays an accepted uncertain synthesis.

- Computer search input: normalize keyboard chords before dispatch, preserve malformed Driver response diagnostics, clarify window-image coordinates and whole-window uncertainty fences, and expose permission-checked foreground delivery for background navigation that has been observed to have no effect.

- Fixes Agent Breeze voice registration/inline reference uploads returning HTTP 400: converts native FormData for the proxy-aware Undici fetch. Preserves server error details and clarifies saved-reference versus description-only voices without promising identical long-form timbre.

- Reply read-aloud now shows playback/service failures in the existing toast, handles audio-device initialization errors, and replaces closed pre-unlocked audio contexts instead of silently returning to the speaker icon.

- Custom Breeze voices now require preview playback and explicit save before joining the library, without changing the default voice. Adds confirmed deletion of saved custom voices and discardable description/recording/upload previews.

- Voice creation works on local HTTP domains using the shared UUID helper; creation errors are visible and the button reports busy state instead of silently doing nothing.

- Saved Breeze voices use the MLX reference-only conditioning branch and an explicit seed; omitting instructions alone still let the service inject a default voice instruction.

- Streaming speech now buffers PCM against measured delivery jitter, schedules continuous 24 kHz playback and fades exposed edges; voice speed uses the shared settings picker instead of stepper buttons.

- Voice cloning now exposes microphone selection, keeps it available after recording, and clears stale recording errors on retry.

- Computer P0: bind UI actions to explicit viewRef and full-window image pixels; validate geometry and ownership before dispatch, keep readback under the action lock, expose semantic result verification, and block uncertain/repeated unchanged writes and generic desktop Connector bypasses. Agent Computer E2E now checks independent owned-window values instead of echoed transcript answers.

- Saved Breeze voices now reuse their reference without resending voice-design descriptions on each read-aloud, avoiding unintended timbre edits between answers.

- Simplifies voice settings into engine/voice rows with previews, per-engine defaults and shared reading/speed controls; adds a collapsible Breeze studio for description, recording and uploaded-reference cloning.

- Recording now identifies insecure HTTP contexts instead of falsely reporting an unsupported browser; local Web supports an explicitly configured HTTPS proxy origin.

- Agent Breeze speech now exposes a Session-bound live player before tool completion, with optional speak autoplay, one synthesis request, and a final reusable WAV.

- Speech now supports only macOS native, Kokoro and BreezeBlue; removes ChatTTS routing and adapters while preserving historical audio playback.
- Adds shared Web/Agent engine, voice and speed settings, readable scripts, saved voice profiles and persistent Breeze reference voices. Reply read-aloud uses a hover speaker icon.

### Added

- Web reply streaming read-aloud through the independent Breeze service: same-origin PCM forwarding, incremental playback, stop/disconnect cancellation and bounded buffering.

- Consolidate the existing experimental meeting-to-NotebookLM Skill; it remains excluded from published packages.

- Optional `MIMI_WEB_HOSTNAME` local Web alias with exact Host and same-origin validation; the server remains bound to loopback.

- Local Breeze TTS 2 speech engine: `MIMI_TTS_BREEZE_URL` points the `speech` tool at a separate loopback speech service, including Apple Silicon MLX, through its form-based `/v1/audio/speech` endpoint. Five design-based voices (`breeze:zh-narrator`, `breeze:zh-lively`, `breeze:zh-male`, `breeze:en-narrator`, `breeze:en-warm`) route by language; the ChatTTS 300-character cap does not apply.

### Fixed

- Discover installed Skills by task purpose across capability sources, include bounded purpose descriptions in new-session context, and reconsider capabilities after poor results without preferring generic tools solely because they are directly visible.

- Match the MLX Breeze form/PCM API and wrap complete PCM responses in valid WAV files; reject malformed audio and interrupted transfers without retrying. Document independent model/service deployment.

- Integrate Computer launch target verification, AX/window identity checks, bounded observation, and explicit foreground handoff.

- Restore immediate Web conversation-list updates, automatic composer focus for new conversations, collapsible navigation, and workspace labels.
- Verify capability-existence questions against installed Skills and include every loaded Skill in the context index.

- Local HTTP Web domains no longer stall during initialization when the browser does not expose `crypto.randomUUID`; session, request, queue, and attachment IDs use cryptographic random bytes.

- `npm ci` no longer fails with `EBADPLATFORM` on Linux, Windows, and Intel macOS. The macOS ARM CUA driver binary is provided by `@trycua/cua-driver`'s own optional dependencies instead of being a root dev dependency; the explicit entry aborted installs everywhere except Apple Silicon.
- Removed a committed `.hallmark` runtime log, a non-fixture macOS home path in a planning document, and two private organization markers in tests; workspace memory written by the agent at runtime is now ignored so a local run cannot dirty `npm run ci`.

### Changed

- Remove Bing HTML search and implicit search fallback. Keep OpenAI hosted search and explicitly configured Google CSE; discover other configured search capabilities through Skills/MCP. Move `http_get` behind capability discovery and stop repeated searches that add no useful evidence.

- Reorganized public documentation into a concise bilingual project overview, focused getting-started/configuration/CLI guides, an English architecture overview, and categorized documentation indexes.
- Added bilingual contribution, security, and community conduct documentation.

## [0.12.0] - 2026-08-05

### Added

- Local-first CLI and durable daemon runtime built on the OpenAI Agents SDK.
- Session, Goal, Plan, Team, Memory, Connector, Browser, Computer, and scheduled task support.
- Provider-aware model routing for OpenAI, DeepSeek, and OpenAI-compatible endpoints.
- Atomic state stores, execution receipts, retry fencing, and bounded diagnostic tools.
- Public Connector examples for macOS services, browser access, RSS/weather, and file activity.

### Security

- Keep credentials in ignored environment files or process environment variables.
- Treat external event and page content as untrusted data.
- Bind daemon control to an authenticated owner-only local socket.
- Prevent uncertain external actions from being replayed automatically.
- Exclude runtime databases, sessions, traces, personal data, generated assets, and private workspace material from the repository and package.

## [0.1.0] - 2026-07-13

- Initial public release.
