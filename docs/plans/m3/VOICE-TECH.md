# M3 语音技术选型

## 结论

Mimi 首版语音采用单 Agent 的级联链路：

```text
macOS ASR -> MimiChatClient -> Daemon -> canonical Session/Run -> TTS
```

用户听到的内容必须等于 canonical Mimi Run 写入 Session 的回答，不启动第二个语音 Agent，
也不播放 Realtime 模型另行生成的一份回答。当前产品入口是 `mimi voice`。

## 当前实现

- ASR：Swift helper 使用 `SFSpeechRecognizer` 和 `AVAudioEngine`。默认要求设备端识别；只有
  显式传 `--allow-network-asr` 才允许系统选择联网识别。partial transcript 在 900 ms 没有新文本
  后形成稳定轮次，单段最长 30 秒。
- Agent：每个语音进程只打开一个现有 Mimi Session。每条稳定 transcript 都走普通
  `MimiChatClient -> Daemon -> Provider` 路径，因此继续使用相同上下文、工具策略和持久状态。
- TTS：默认使用 macOS 系统 TTS，零模型下载即可启动。`--tts kokoro` 可显式接入本地 renderer；
  renderer 只接收短生命周期的 `0600` 文本文件并返回 WAV，播放完立即清理。
- 回声控制：首版在模型执行和播报期间暂停麦克风，播报结束后恢复。这是可用的半双工闭环，
  不是 barge-in 或全双工实现。

## 调研取舍

| 方案 | 结论 |
|---|---|
| Apple `SpeechAnalyzer` + `SpeechTranscriber` + `SpeechDetector` | 长期首选 macOS ASR/VAD API；支持异步流式模块和独立 VAD，但 microphone sequence provider 仍标为 Beta，当前保留为升级项。 |
| Apple `SFSpeechRecognizer` | 当前基线；系统原生、可请求设备端、无额外模型安装，适合先交付 Mac 语音入口。 |
| `whisper.cpp` + Silero VAD | 跨平台/离线 fallback；已有流式 VAD，但需要下载模型、管理音频转换和常驻推理资源，不作为 Mac 零配置默认。 |
| macOS system TTS | 当前默认；启动快、无需模型。后续应从 `say` 收敛到 `AVSpeechSynthesizer`，获得正式的停止、队列和播放完成回调。 |
| Kokoro 82M / MLX | 可选高质量本地 TTS；体积小、Apache-2.0 权重、Apple Silicon 可用，中文需对应 voice/G2P。保留为显式 renderer，不硬编码个人 Skill 路径。 |
| ChatTTS | 不作为产品默认；代码为 AGPLv3+、模型为 CC BY-NC 4.0，官方还说明训练时主动加入高频噪声，不适合 Mimi 的通用分发和默认音质路线。 |
| Qwen3-TTS | 质量和中文表现值得后续评测，但官方快速路径面向 Python/CUDA/FlashAttention，0.6B/1.7B 的启动与内存成本明显高于 Kokoro，不作为当前 Mac 基线。 |

官方资料：

- [Apple Speech](https://developer.apple.com/documentation/speech/)
- [Apple SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)
- [Apple AVSpeechSynthesizer](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- [ChatTTS](https://github.com/2noise/ChatTTS)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)

## 使用

```bash
# 零配置系统声音
mimi voice

# 允许系统使用联网 ASR
mimi voice --allow-network-asr

# 显式使用现有 Kokoro renderer
mimi voice --tts kokoro \
  --voice zm_yunyang \
  --kokoro-renderer /absolute/path/to/render_kokoro_audio.sh
```

## 尚未完成

- 真实麦克风权限、真实用户语音和 live Provider 的验收仍为 0 轮。
- 说话时打断 TTS、运行中取消旧 canonical Run、低于 750 ms 的 barge-in 指标尚未完成。
- `SpeechAnalyzer/SpeechDetector`、`AVSpeechSynthesizer` 和 `whisper.cpp` fallback 尚未接入。
- 当前只支持 macOS；Kokoro renderer 是可选外部本地能力，不随 Mimi 包安装模型。
