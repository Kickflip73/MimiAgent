---
name: audio-briefing
description: 将中文研究简报、文章或长文改写成口语讲解稿，使用 macOS 系统语音分段串行合成音频，保存并校验时长与格式。用于音频简报、长文转音频、每日播报。默认不播放，不使用 ChatTTS 或下载大型本地模型。
---

# 音频简报

1. 先保留有来源链接的原始简报，再写独立 UTF-8 讲解稿。用中文短句串联主题，解释缩写，保留事实与推断的区别；不朗读网址、Markdown 标记或表格。
2. 将讲解稿保存在此次任务的输出目录，例如 `narration.txt`。长度控制在 24,000 字符以内。超限时压缩讲解稿，完整文字简报仍保留。
3. 从此 Skill 的实际目录执行：

```bash
python3 scripts/render_audio.py --input /absolute/path/narration.txt --output-dir /absolute/path/audio
```

脚本自动选择已安装的中文系统音色，以每段至多 400 字符串行合成，通过 FFmpeg 合并为 MP3。每段有超时，成功片段按文本摘要缓存。没有 GPU 推理，也不加载 ChatTTS、Kokoro、MLX、Torch 等大型模型。不要并发启动多个合成任务。

4. 检查返回 JSON：`verified` 必须为 `true`，音频时长必须大于零，报告文字稿路径、音频路径和时长。保留 `manifest.json` 作为交付依据。脚本退出非零时按真实错误报告部分完成，不宣称音频已生成。
5. **只生成并保存。不要调用 `open`、`afplay`、播放器、自动播放或内置 speech 播放工具。** 只有用户之后明确要求播放指定文件时，才在新的用户指令下播放。

依赖：macOS 的 `/usr/bin/say`、已安装中文音色、`ffmpeg`、`ffprobe`。缺少依赖时明确报告；禁止自动下载语音模型或回退到 ChatTTS。此 Skill 不收集新闻、不伪造来源、不主动发送外部消息；通知沿用当前任务已有的交付渠道。
