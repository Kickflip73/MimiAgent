#!/usr/bin/env python3
"""Bounded, serial macOS speech generation; never starts a player."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess
import sys
import time
import tempfile


def split_text(text, limit=400):
    chunks, current = [], ''
    for sentence in re.split(r'(?<=[。！？!?；;\n])', text):
        while sentence:
            available = limit - len(current)
            current += sentence[:available]
            sentence = sentence[available:]
            if len(current) == limit:
                if current.strip(): chunks.append(current.strip())
                current = ''
        if len(current) >= limit // 2:
            if current.strip(): chunks.append(current.strip())
            current = ''
    if current.strip(): chunks.append(current.strip())
    return chunks


def execute(args, timeout=90):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} 执行失败：{result.stderr[-1000:]}')
    return result.stdout


def inspect_audio(probe, file):
    value = json.loads(execute([probe, '-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', str(file)], 20))
    duration = float(value.get('format', {}).get('duration', 0))
    if duration <= 0 or not any(s.get('codec_type') == 'audio' for s in value.get('streams', [])):
        raise RuntimeError('音频校验失败：缺少音轨或时长为零')
    return duration


def generate(source, destination, voice=None):
    if sys.platform != 'darwin': raise RuntimeError('此音频方案需要 macOS')
    if source.stat().st_size > 200_000: raise ValueError('讲解稿超过 200 KB，请先压缩讲解稿')
    text = source.read_text(encoding='utf-8').strip()
    if not text or len(text) > 24_000: raise ValueError('讲解稿必须为 1–24000 字符')
    ffmpeg, probe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    if not ffmpeg or not probe: raise RuntimeError('缺少 ffmpeg / ffprobe')
    voices = re.findall(r'^(.+?)\s+zh_CN\s+#', execute(['/usr/bin/say', '-v', '?'], 20), re.M)
    if not voices: raise RuntimeError('未安装中文系统音色，请在 macOS 设置中安装')
    selected = voice or next((v for v in voices if v == 'Tingting'), voices[0])
    if selected not in voices: raise ValueError('请选择已安装的中文系统音色')
    digest = hashlib.sha256((text + '\0' + selected + '\0rate=220').encode()).hexdigest()
    output = destination / f'briefing-{digest[:16]}'
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (output / '.render.lock').open('w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('同一讲解稿正在生成，请等待完成')
        audio = output / 'briefing.mp3'
        manifest = output / 'manifest.json'
        if manifest.exists() and audio.exists():
            existing = json.loads(manifest.read_text())
            if existing.get('inputDigest') == digest:
                inspect_audio(probe, audio)
                return existing
        chunks = split_text(text)
        files = []
        started = time.monotonic()
        for index, chunk in enumerate(chunks):
            if time.monotonic() - started > 900: raise TimeoutError('音频生成超过 15 分钟，已保留完成的片段')
            piece = output / f'{index:04d}.aiff'
            if piece.exists():
                try: inspect_audio(probe, piece)
                except Exception: piece.unlink()
            if not piece.exists():
                script = output / f'{index:04d}.txt'
                script.write_text(chunk, encoding='utf-8')
                temporary = output / f'{index:04d}.partial.aiff'
                try:
                    execute(['/usr/bin/say', '-v', selected, '-r', '220', '-f', str(script), '-o', str(temporary), '--file-format=AIFF'])
                    inspect_audio(probe, temporary)
                    temporary.replace(piece)
                finally: temporary.unlink(missing_ok=True)
            files.append(piece)
            print(f'片段 {index+1}/{len(chunks)} 已完成', file=sys.stderr, flush=True)
        listing = output / 'segments.txt'
        listing.write_text(''.join(f"file '{p.name}'\n" for p in files), encoding='utf-8')
        temporary = output / 'briefing.partial.mp3'
        try:
            execute([ffmpeg, '-nostdin', '-v', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-f', 'concat', '-safe', '1', '-i', str(listing), '-vn', '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-threads', '1', str(temporary)], 120)
            duration = inspect_audio(probe, temporary)
            temporary.replace(audio)
        finally: temporary.unlink(missing_ok=True)
        result = dict(verified=True, engine='macos-say', voice=selected, inputDigest=digest,
            narration=str(source), audio=str(audio), durationSeconds=round(duration, 2),
            chunks=len(chunks), maxChunkCharacters=max(map(len, chunks)),
            childPeakRssBytes=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
            autoplay=False)
        temporary_manifest = output / 'manifest.tmp'
        temporary_manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        os.chmod(temporary_manifest, 0o600)
        temporary_manifest.replace(manifest)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--voice')
    args = parser.parse_args()
    try:
        lock_path=Path(tempfile.gettempdir()) / f'mimi-audio-briefing-{os.getuid()}.lock'
        with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'w') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise RuntimeError('已有音频任务正在生成，请稍后重试；不会并行加载语音')
            print(json.dumps(generate(args.input.resolve(), args.output_dir.resolve(), args.voice), ensure_ascii=False))
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired, TimeoutError) as error:
        print(str(error), file=sys.stderr); return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
