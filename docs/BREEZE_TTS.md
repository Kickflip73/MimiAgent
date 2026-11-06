# Breeze TTS 2 (local speech)

MimiAgent can render speech through a separate local [Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts) service. The model, Python environment and service lifecycle stay outside MimiAgent; its `speech` tool only calls HTTP. Kokoro uses `MIMI_TTS_COMMAND`; macOS uses `/usr/bin/say` directly. ChatTTS is removed.

## Apple Silicon: independent MLX service

The community [MLX streaming server](https://github.com/Shoofio/breeze-tts2-fast-streaming-api) supports Apple Silicon. The mixed-precision [Gust-MLX checkpoint](https://huggingface.co/Shoof/Gust-MLX) keeps the backbone in bf16 and quantizes depth decoder linear layers to int8. It is an unofficial conversion; actual speed and memory use depend on the machine and text.

Install outside the MimiAgent repository (Python 3.12 and `uv`):

```bash
git clone https://github.com/Shoofio/breeze-tts2-fast-streaming-api.git breeze-mlx
cd breeze-mlx
git checkout f1818ec44da33302701718e5fb15267ce1cf5e4f
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt --overrides requirements-mac-overrides.txt
uvx --from huggingface_hub hf download Shoof/Gust-MLX \
  --revision dac391237f6bf6130b1c1d277f0ebc0b886e419e \
  --local-dir ../breeze-mlx-model --exclude 'samples/*'
BREEZE_MLX_COMPILE=1 BREEZE_MLX_FAST_FIRST=6 BREEZE_MLX_CACHE_GB=1 \
  .venv/bin/python -m breeze_infer.api ../breeze-mlx-model \
  --backend mlx --host 127.0.0.1 --port 8080 --ws-port disabled \
  --chunk-first 1 --chunk-max 1 --voices-dir ../breeze-mlx-voices
```

Keep the service bound to loopback, with WebSocket and CORS disabled when only MimiAgent calls it. A separate macOS LaunchAgent can supervise this same command; use absolute paths, the server checkout as its working directory, and its own logs. Restarting MimiAgent does not need to reload the speech model. Model loading and warmup may take time; readiness is `GET http://127.0.0.1:8080/health` returning HTTP 200 with `status: "ok"`.

### Long first-audio delays after idle on macOS

The observed cold request took 41 seconds before first audio, although `/health`
was ready. GPU idle can drop model residency; the next request then reloads it
under memory pressure. A 0.32.4 trial with native residency refresh was **not**
accepted: an idle replay stalled in Metal residency operations for 85 seconds on
this macOS host. Keep the validated MLX 0.32.3 environment; do not enable
`MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS` for this deployment.

Apply `scripts/tts/breeze-resident-memory.patch` to the independent server while
idle and configure:

```sh
BREEZE_MLX_WIRED_GB=8
BREEZE_MLX_CACHE_GB=1
```

The patch performs one scalar GPU operation per idle second on the existing GPU
worker, under a non-waiting gate lease. It never synthesizes audio, advances model
sampling/codec state, or queues ahead of a real request. The task stops with the
service. This follows the small-GPU-operation workaround discussed in the
[upstream idle-residency issue](https://github.com/ml-explore/mlx/issues/4609),
without using a concurrent native residency-refresh thread.

The 8 GB residency budget is for this checkpoint on a 24 GB Mac. It keeps that
memory available to the model at the cost of less reclaimable RAM and a small
amount of idle GPU activity. Budgets exceeding half physical RAM or the system
Metal limit are rejected; system limits are never raised. Smaller machines need
a smaller budget. Model weights, reference voices and sampling remain unchanged.
Verify first-audio latency after several idle minutes, not only warm requests.
This addresses idle reloads, not waiting behind another synthesis.

## Point MimiAgent at it

Add to `~/.mimi-agent/.env`:

```dotenv
MIMI_TTS_ENABLED=true
MIMI_TTS_BREEZE_URL=http://127.0.0.1:8080
# Optional voice-design instruction when no preset voice is requested:
# MIMI_TTS_BREEZE_INSTRUCTION=A warm, calm narrator with clear articulation.
```

Restart the daemon (`mimi daemon restart`) after changing the environment. With the URL set, `engine: "auto"` resolves to Breeze. In Mimi, ask for speech, or invoke the `speech` tool with:

```json
{"action":"synthesize","input":"你好，这是本地语音测试。","voice":"breeze:zh-narrator"}
```

```json
{"action":"synthesize","input":"Hello. This speech is generated locally.","voice":"breeze:en-narrator"}
```

## Voices

Each preset is a voice-design instruction, not a registered server `voice_id`:

| Voice id | Language | Description |
| --- | --- | --- |
| `breeze:zh-narrator` | zh | 沉稳温暖的中文女声，适合长篇旁白 |
| `breeze:zh-lively` | zh | 轻快亲切的中文年轻女声 |
| `breeze:zh-male` | zh | 低沉克制的中文男声，适合解说 |
| `breeze:en-narrator` | en | Clear, calm English narrator |
| `breeze:en-warm` | en | Relaxed conversational English male voice |

`speech` with `action: "voices"` lists them. Passing a preset pins the engine and instruction. Saved and cloned profiles appear in the same selector as `saved:<id>`.

## Protocol and limits

- `POST /v1/audio/speech` uses URL-encoded `text` and optional `instruction` fields. The MLX API does **not** accept OpenAI-style JSON even though the route has the same name.
- MLX returns `audio/pcm`, `X-Sample-Rate: 24000`, `X-Sample-Format: s16le`: mono PCM16LE. MimiAgent streams incoming audio into its private media directory and finalizes the WAV header on completion. Both Agent speech and the Web reply’s speaker icon support incremental playback (see below).
- WAV responses are also accepted; other audio types, invalid PCM metadata, odd sample lengths, empty audio and interrupted transfers fail instead of becoming misleading `.wav` files.
- Breeze uses `MIMI_TTS_SYNTHESIS_TIMEOUT_MS` (default 180 seconds) as an inactivity timeout, refreshed by arriving audio. A story with continuous progress may take longer overall. Native/Kokoro command timeouts retain their existing meaning. Cancellation still stops pending/running work.
- The local client admits one request per service origin, with at most 16 pending/running requests per process and a 10-minute admission deadline. An explicit HTTP 409 with `code=busy` means the server did not accept the work: the client waits and attempts admission again. Other 409s, 503s, connection failures and interrupted accepted audio are never automatically replayed. Use `speech inspect` for an uncertain render.
- The service still runs one GPU generation at a time. Mimi requests a weighted text split budget of 750 (CJK characters weigh more than ASCII), with `max_new_tokens=1200` (still clamped by available context), reducing frequent speaker resets without disabling output limits. All text is passed through in order; it is not summarized. The upstream request limit remains 10,000 characters; longer works need sequential original-text chapters. More GPU concurrency is not enabled merely by removing the busy check, because the runtime shares model/codec state and additional instances consume memory.
- `busy` alone is not evidence of a hung service. Another conversation may own a healthy long render. Do not kill or restart it to bypass admission; new `speech.piece_done` events show ongoing progress. A restart that interrupts active work requires explicit user direction.
- The speech service needs no language-model API key. After model installation it can run offline; MimiAgent's conversational model configuration is separate.


### Single-speaker long-form requests

Mimi sends `stable_voice=1`, `seed=42`, `split_chars=750`
(weighted, roughly 250 Chinese characters), and `max_new_tokens=1200`, retaining
the model sampling defaults. This needs
the local service extension in `scripts/tts/breeze-stable-voice.patch`, based on
server revision `f1818ec44da33302701718e5fb15267ce1cf5e4f`:

```sh
# Run from the independent breeze-mlx checkout, while its service is idle.
git apply --check /absolute/path/to/MimiAgent/scripts/tts/breeze-stable-voice.patch
git apply /absolute/path/to/MimiAgent/scripts/tts/breeze-stable-voice.patch
# Restart that service normally after its active work finishes.
```

The extension leaves ordinary callers unchanged. With `stable_voice=1`, every
piece uses the same seed and reference-only conditioning. A description-only
request designs its first piece, then fixes that exact piece as the reference for
the rest; if the reference cannot be retained, the stream fails instead of
silently designing another speaker. The first piece still uses its short opening
budget so the reference is bounded. Registered voices reuse their original
reference throughout; no new profile is created or selected.

The server acknowledges the extension with `X-Breeze-Stable-Voice: 1`. Mimi cancels
an unacknowledged response and asks for the service update, rather than silently
claiming an older/other server supports the contract. This also means an unpatched
third-party Breeze server must be adapted before it can serve Mimi speech.

The transport contract prevents per-piece reseeding, reference replacement and
silent fallback to voice design. A generative model can still vary its prosody;
verify audible consistency with real long passages, not just a fixed seed or a
successful WAV. The upstream [long-form consistency discussion](https://github.com/breezeblue-ai/breeze-tts/issues/25)
likewise distinguishes repeatability from speaker consistency.

## Licensing

The server code is Apache-2.0. Breeze TTS 2 weights, derivative models and self-hosted outputs use the [BreezeBlue Research and Non-Commercial License](https://huggingface.co/Shoof/Gust-MLX/blob/main/LICENSE).

## Streaming in replies and Agent calls

The reply speaker button uses `POST /api/speech/stream`. Agent `speech speak` and
`synthesize` also expose audio **while their tool call is still running**. The Host
claims one render receipt, binds it to the immutable Session/run, writes incoming PCM
to its WAV, and emits one compact `speech_ready` event after the first bytes arrive.
The Web player reads `GET /api/speech/live?session=<session>&id=<audioId>` from that
same growing file; it never submits a second TTS request. Final success updates the
WAV header and commits the ready receipt for normal historical playback.

`speak` requests automatic playback in the current conversation. The Send gesture
unlocks audio; browsers may still require a click, in which case the early player
shows that action. `synthesize` presents the player without autoplay. Reloading or
opening an old conversation does not autoplay it. HTTP reconnects and replayed events
reuse the audio ID. A reader disconnect stops listening but does not cancel the
Agent's durable synthesis; cancelling the Agent run aborts synthesis. Failed streams
error rather than emitting a successful EOF, and partial WAV files are removed.

PCM delivery remains 24 kHz mono s16le with a bounded playback queue. The live route
checks Session ownership, receipt state and filesystem containment before opening the
file. It cannot accept arbitrary filenames or create new synthesis. Native macOS and
Kokoro still return completed WAV files. Voice design, saved references and speed
settings apply identically to button and Agent requests.

## Engine, voice and reading settings

Web **设置 → 语音** and the Agent's `speech` tool share atomic settings in
`<dataRoot>/media/tts/speech-settings.json`. Available engines are `macos`, `kokoro`,
`breeze`; `auto` prefers configured Breeze, otherwise macOS on a Mac or Kokoro.
An explicit engine failure never triggers another engine. Old ChatTTS audio remains
playable, but its engine/voice IDs are rejected for new synthesis.

`settings`/`voices` returns capabilities, built-in voices and saved profiles.
`configure` saves defaults. `synthesize` options override only the current call.
`prepare` returns an independent reading script and warnings, converting Markdown
tables to labeled sentences and expanding common dates, percentages and units.
The original conversation is unchanged. `textMode: verbatim` bypasses preparation.
This is conservative rule-based normalization, not a universal pronunciation model;
for semantic rewriting use the `speech-studio` Skill and inspect the script.

For voice design, use `voice_preview` to generate temporary audio, let the user listen,
then call `voice_confirm` only after explicit approval to add it to the library.
`voice_discard` removes the temporary preview. Preview does not create a saved profile
or register a Breeze voice; confirmation registers the exact auditioned reference.
Neither preview nor confirmation changes the default voice. Operation receipts prevent
duplicate generation/registration; uncertain operations are not automatically replayed.

`voice_save` saves a preset or description with `id`, `name`, and synthesis options.
`voice_generate` (Breeze only) generates a short sample (`input`, at most 80 chars)
and registers it with `/v1/voices`, then persists the returned reference ID.
Select it with `voice: saved:<id>`. Description-only presets may vary between runs;
a saved reference provides a reusable voice. Failed generation remains uncertain,
without automatic retries. `voice_remove` removes the profile and deselects it,
retaining historical audio and server reference assets.

Speed is 0.5–2: native macOS rate, Kokoro speed, and FFmpeg `atempo` for Breeze.
FFmpeg must be installed for Breeze speeds other than 1; no model download is involved.
Breeze streams PCM with backpressure; macOS/Kokoro return completed WAV files.
The reply speaker icon follows the copy/time hover behavior, remains visible during
playback, and exposes an accessible label and stop action. Temporary settings can be
auditioned without saving defaults.
Playback and service failures appear in the shared Web toast as well as the button's
accessible label; a failed attempt releases its audio resources and can be retried
explicitly. A closed pre-unlocked browser audio context is replaced on the next click.


## Simple Web voice settings

Settings shows three engine rows (Breeze, Kokoro, macOS), each with the shared custom voice picker, a speaker preview and a default-engine button. Voice selections are saved independently per engine; reading mode and speed are shared with the Agent and apply to saved voices too. Existing settings without `engineVoices` are read without resetting profiles or defaults.

Only the selected Breeze engine reveals the collapsible voice studio. Choose description, recording or upload; give the voice a name. Each method generates an unsaved preview. Start playback, then choose **保存音色** to add it to the library, or **放弃** to discard it. Saving does not select the new voice. Recording/upload requires the matching transcript. The browser decodes and downmixes a 1–30 second clip (maximum 16 MB source) to PCM16 mono WAV; the server validates its header, duration and size before previewing through the independent Breeze service. Clone previews use inline reference audio without registering a saved voice. Uploads use the existing same-origin media path and immutable IDs, never a browser-supplied filesystem path. Microphone recording requires a secure browser context.

Select a custom voice to show its delete button; an inline confirmation explains when deletion will restore the engine's default voice. Presets cannot be deleted. Removing a profile retains historical audio and server reference assets. Existing saved voices are never bulk-cleaned automatically.

The legacy `voice_generate` and `voice_clone` actions save immediately and are only appropriate when saving is already explicitly authorized. `voice_clone` in the Agent accepts an existing WAV path in `input`, its exact `transcript`, `id` and `name`. `engine_voice` stores an engine's voice without switching the active engine.


### Stable saved voices

Check the live profile's `referenceId`, not its name or retained creation description,
to distinguish a saved reference from a description-only preset. Fixed reference and
seed do not promise identical voices across different text or eliminate long-form drift.
The deployed MLX server splits long input by weighted text length (server default budget 600; Mimi requests 750),
restarts generation with the same reference for each piece, and by default uses `seed + piece_index`. Mimi now requests the local `stable_voice=1` extension, which keeps the request seed unchanged instead.
A sudden change may align with a piece boundary; confirming that requires the exact
text/audio and service `speech.piece_done` events. Do not disable splitting for arbitrary
long text, which can exceed model context/output limits.

Agent and Web uploads must both send real multipart data. The Agent's proxy-aware fetch
uses the installed Undici, whose FormData brand differs from Node's built-in FormData;
the runtime converts native forms before dispatch. Without this conversion, voice upload
became `text/plain` containing `[object FormData]` and failed with HTTP 400. Registration
errors now retain the server's bounded error body. A failed voice operation is still not
automatically replayed or replaced with a new ID.

Saved reference voices (`saved:<id>` with `referenceId`) send `voice_id`, `cfg_scale=0` and a fixed `seed=42`. The MLX service fills in a default instruction even if none is sent; scale 0 selects its reference-plus-plain-text branch (also when using a cached reference prefix). This is reference continuation, not voice redesign. Their creation description stays in the profile as metadata and is not resent as a voice-edit instruction. This applies to reply read-aloud, previews and Agent synthesis. Presets and description-only profiles without a reference still use voice design and can vary across texts; generate and save a reference to reuse a speaker. A fixed reference does not promise identical prosody across different text or languages.

In Web settings → 定制 Breeze 音色 → 录音克隆, use 录音麦克风 to select an input. Available devices appear after the first microphone permission grant. Switching during recording discards that take and starts a new one; the selector remains available after stopping or a silent recording error.


### Streaming playback buffering

The Web player accumulates 0.8 seconds of PCM before starting and increases the initial cushion up to 3.2 seconds of audio when measured arrivals are slower than consumption. Network chunks are regrouped into 200 ms blocks on a continuous 24 kHz audio clock. A 5 ms gain fade covers startup, stream end and underrun edges; scheduled fades are removed at normal continuous joins. On starvation the player buffers again instead of repeatedly restarting tiny packets. Queued audio remains bounded by backpressure, cancellation stops queued sources, and short clips flush at EOF.

Normal completion waits for the output-device timestamp to pass the final sample before closing AudioContext; rendering time alone can run ahead of audible output. Browsers without that timestamp get a bounded device-latency grace period. Explicit stop still cancels immediately. Breeze speed conversion pads its input with 150 ms of silence so FFmpeg's atempo analysis window can drain the final real phoneme.

At faster speech rates the same synthesis throughput supplies fewer seconds of playback per second. Additional startup buffering trades latency for continuity; it cannot guarantee uninterrupted playback if sustained generation is slower than consumption or the device is heavily loaded. The settings speed control uses the shared custom picker and preserves existing exact rates (including rates not in the preset list).


Description-based voice creation and uploaded-reference cloning work on local HTTP hostnames using the shared browser UUID helper (`getRandomValues`), without requiring `crypto.randomUUID`. The creation button shows its busy state and surfaces failures; validation focuses the missing field. Microphone recording still requires a secure context. Browser regression covers both localhost with the secure-only API absent and a real custom HTTP origin.
