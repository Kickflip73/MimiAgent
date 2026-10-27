# Breeze TTS 2 (local speech)

MimiAgent can render conversation audio through a local [Breeze TTS 2](https://github.com/BreezeBlue/Breeze-TTS-2) server instead of a renderer script. Speech stays on the machine: the runtime posts text to `breeze-server`, which streams a WAV back over loopback.

This is an opt-in engine. ChatTTS and Kokoro through `MIMI_TTS_COMMAND` keep working unchanged.

## Start the server

```bash
breeze-server breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 8080
```

The Windows portable build ships `breeze-server.exe`; on other platforms use the source build. Keep the server loopback-bound: it has no authentication.

## Point MimiAgent at it

Add to `~/.mimi-agent/.env`:

```dotenv
MIMI_TTS_ENABLED=true
MIMI_TTS_BREEZE_URL=http://127.0.0.1:8080
# Optional: voice-design instruction used when no preset voice is requested.
# MIMI_TTS_BREEZE_INSTRUCTION=A warm, calm narrator with clear articulation.
```

Restart the daemon (`mimi daemon restart`) after changing the environment.

With `MIMI_TTS_BREEZE_URL` set, `engine: "auto"` resolves to Breeze, so `speech synthesize` works without naming an engine.

## Voices

Breeze designs a voice from a text description, so each preset is a stored instruction:

| Voice id | Language | Description |
| --- | --- | --- |
| `breeze:zh-narrator` | zh | 沉稳温暖的中文女声，适合长篇旁白 |
| `breeze:zh-lively` | zh | 轻快亲切的中文年轻女声 |
| `breeze:zh-male` | zh | 低沉克制的中文男声，适合解说 |
| `breeze:en-narrator` | en | Clear, calm English narrator |
| `breeze:en-warm` | en | Relaxed conversational English male voice |

`speech` with `action: "voices"` lists them. Passing `voice: "breeze:zh-narrator"` pins both the engine and the design instruction.

To use a cloned voice, register it with the Breeze server first (`POST /v1/voices`, or save it from the bundled web UI) and pass its saved id. Cloning requires the speaker's authorization.

## Behavior and limits

- Text goes to `POST /v1/audio/speech` with `response_format: "wav"`; MimiAgent writes the returned 16-bit mono 24 kHz WAV into the private media directory and records a render receipt.
- Requests are bounded by `MIMI_TTS_SYNTHESIS_TIMEOUT_MS` (default 180 s) and honour run cancellation.
- A refused connection raises an actionable error naming the `breeze-server` command rather than a raw fetch failure; a failed or non-audio response records an `uncertain` receipt and is never retried automatically, matching the ChatTTS/Kokoro path.
- Long text is fine: Breeze splits internally (`--split-chars`, default 600). The 300-character ChatTTS cap does not apply.
- First audio on a cold GPU includes Vulkan pipeline setup. Start the server without `--no-warmup` to absorb that cost at boot.

## Licensing

The runtime integration is Apache-2.0-compatible code in this repository. The Breeze TTS 2 **model weights** are released under the BreezeBlue Research and Non-Commercial License: generated audio is for research and non-commercial use, and commercial use requires the hosted offering. Review that licence before shipping generated audio.
