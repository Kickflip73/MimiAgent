# Local speech resource limits

The `speech` Host rejects ChatTTS input exceeding 300 UTF-16 characters before creating a render receipt or starting a renderer. This includes auto-selected Chinese and ChatTTS voice IDs. Short ChatTTS speech remains available; text is never silently truncated, and long text must not be split into repeated ChatTTS calls to bypass this policy. Existing audio playback is unaffected.

For long articles and briefings, use `skills/audio-briefing` (macOS system speech, bounded sequential chunks). This is an explicit alternative, not an automatic switch of voice or engine after failure.

## Existing local Python renderer

The user-installed ChatTTS renderer is outside the npm runtime. To update the supported existing renderer without downloading models:

```sh
python3 scripts/tts/install_local_guard.py "$HOME/.mimi-agent/runtime/tts"
python3 scripts/tts/test_chattts_safety.py
```

The installer validates all expected source sections before writing and keeps `.before-safety` backups. It refuses unknown revisions for manual review. It does not install a TTS stack. Stop any existing ChatTTS worker before using the updated code; a running Python worker retains its previous implementation.

The client rejects long text before loading the model; the worker repeats validation for direct socket requests. Inference batches contain one sentence instead of four. The existing worker lock prevents concurrent model instances. An independent supervisor checks worker RSS every 250 ms and terminates it above 4 GiB, on failed memory measurement, or after a 180-second total lifetime (including startup and idle time). The worker also caps the MPS allocator at 2 GiB. These conservative limits are fixed, not model-controllable environment overrides. The persistent model is released at the deadline; a later short request may cold-start it again.

A resource failure terminates synthesis without automatically loading Kokoro. An interrupted render remains unconfirmed under the existing receipt/inspect contract and must not be blindly repeated. Polling RSS is a backstop, not a kernel-enforced instantaneous memory ceiling; rapid allocations and memory outside MPS/RSS accounting remain limitations. Other custom renderers must provide their own process-level safeguards; the Host's 300-character limit alone is not a universal memory limit.

## Conversation playback

The Agent's `speech` tool returns audio for the conversation player for `synthesize`, `speak`, and `play`. It never invokes the system player. `play` validates/reuses an existing audio receipt without synthesis. The low-level library `SpeechOutput.play()` remains available for explicit native integrations. A generated file is not evidence that the user has listened to it; the model must not claim playback already happened.

The Host attaches successful speech artifacts to its committed answer. Web history also restores older players from paired canonical speech calls and successful audio receipts, without rewriting the transcript. Audio delivery retains session-reference and filesystem-root checks. Users control play/pause/seek in the conversation; no browser autoplay permission is required.

Voice IDs are exposed as a catalog enum. An obsolete voice is rejected before dispatch, and correction of that field can recover the failure under the existing validation-recovery rules. Long requests must not be summarized or truncated merely to fit ChatTTS; use the long-form system speech option.
