# Local speech resource limits

Only macOS native speech, Kokoro and BreezeBlue are supported. ChatTTS adapters,
presets and automatic routing are removed. Old ChatTTS audio receipts remain readable
for playback; they do not authorize new synthesis. Obsolete engine and voice selections
fail before dispatch. Remove any user-installed ChatTTS worker/environment separately;
the npm package does not manage Python environments.

macOS uses system speech without loading a neural model into MimiAgent. Kokoro remains
an isolated renderer command. Breeze uses an independent local HTTP service, with
bounded streaming buffers and cancellation. Breeze accepts up to 10,000 characters;
other single renders accept up to 20,000. These limits are not a universal memory cap.
For longer articles use `skills/audio-briefing` with bounded sequential system-speech chunks.
No failed request silently falls back to another engine.

Settings and named voice profiles use locked atomic JSON state. Reference-voice generation
claims an operation before synthesis/registration; uncertain operations are not replayed.
Removing a profile retains historical audio and server reference files. Never reset a corrupt
receipt/settings store to bypass uncertainty.

## Conversation playback

The Agent's `speech` tool returns audio for the conversation player for `synthesize`, `speak`, and `play`. It never invokes the system player. `play` validates/reuses an existing audio receipt without synthesis. The low-level library `SpeechOutput.play()` remains available for explicit native integrations. A generated file is not evidence that the user has listened to it; the model must not claim playback already happened.

The Host attaches successful speech artifacts to its committed answer. Web history also restores older players from paired canonical speech calls and successful audio receipts, without rewriting the transcript. Audio delivery retains session-reference and filesystem-root checks. Users control playback in the conversation. Breeze speak exposes a live player before tool completion and requests autoplay only for the current send; if browser policy blocks it, a click starts streaming. synthesize does not autoplay. Live readers require the persisted Session owner, and stopping a reader never starts another synthesis.

Voice IDs come from the live catalog and saved profiles. Unknown or incompatible voices
are rejected before synthesis. Readable mode prepares a separate script, with warnings for
omitted code/URLs; verbatim mode preserves supplied text. Do not summarize or truncate
user-requested content to fit an engine limit.
