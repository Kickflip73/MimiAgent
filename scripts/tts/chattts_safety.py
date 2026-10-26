"""Local ChatTTS guard: reject long input and supervise the inference process."""
import os
import signal
import subprocess
import time

MAX_CHARS = 300
MAX_RSS_KIB = 4 * 1024 * 1024
MAX_LIFETIME_SECONDS = 180
MPS_BYTES = 2 * 1024 ** 3


def validate_text(text):
    # Match the Host's UTF-16 character count, including supplementary characters.
    size = len(text.encode('utf-16-le')) // 2
    if size > MAX_CHARS:
        raise ValueError(f'ChatTTS short speech only: maximum {MAX_CHARS} characters; got {size}. Use audio-briefing system speech for long text; do not split to bypass.')


def rss_kib(pid):
    result = subprocess.run(['/bin/ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True, timeout=2)
    if result.returncode != 0:
        raise RuntimeError('Cannot verify ChatTTS memory usage')
    return int(result.stdout.strip())


def supervise(command, *, max_rss=MAX_RSS_KIB, max_seconds=MAX_LIFETIME_SECONDS, memory_reader=rss_kib):
    # A separate process can stop inference even while Torch holds the worker's GIL.
    child = subprocess.Popen(command, start_new_session=True)
    started = time.monotonic()
    try:
        while child.poll() is None:
            if time.monotonic() - started >= max_seconds:
                raise RuntimeError('ChatTTS worker lifetime exceeded; inference stopped')
            try:
                usage = memory_reader(child.pid)
            except Exception:
                if child.poll() is not None:
                    break
                raise
            if usage > max_rss:
                raise RuntimeError('ChatTTS memory budget exceeded; inference stopped')
            time.sleep(0.25)
        return child.wait()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()
