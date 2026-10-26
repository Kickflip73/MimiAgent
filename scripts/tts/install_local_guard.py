"""Patch the existing local renderer without installing or downloading models."""
import argparse
import ast
from pathlib import Path
import shutil


def replace_once(source, old, new):
    if new in source:
        return source
    if source.count(old) != 1:
        raise ValueError('Unsupported renderer revision; inspect before updating')
    return source.replace(old, new, 1)


def install(root):
    edits = {}
    client = (root / 'chattts_client.py').read_text()
    client = replace_once(client, 'import argparse\n', 'import argparse\nfrom chattts_safety import validate_text\n')
    client = replace_once(client, '    text = args.input.read_text(encoding="utf-8").strip()\n', '    text = args.input.read_text(encoding="utf-8")\n    validate_text(text)\n    text = text.strip()\n')
    edits['chattts_client.py'] = client
    worker = (root / 'chattts_worker.py').read_text()
    worker = replace_once(worker, 'import fcntl\n', 'import fcntl\nfrom chattts_safety import validate_text, supervise, MPS_BYTES\n')
    worker = replace_once(worker, 'MAX_BATCH_SIZE = 4', 'MAX_BATCH_SIZE = 1')
    worker = replace_once(worker, '        torch.manual_seed(42)\n', '        if self.device.type == "mps":\n            torch.mps.set_per_process_memory_fraction(min(1.0, MPS_BYTES / torch.mps.recommended_max_memory()))\n        torch.manual_seed(42)\n')
    worker = replace_once(worker, '        np = self.np\n', '        validate_text(text)\n        np = self.np\n')
    worker = replace_once(worker, '    sys.exit(main())\n', '    if "--mimi-tts-guarded" in sys.argv:\n        sys.exit(main())\n    sys.exit(supervise([sys.executable, __file__, "--mimi-tts-guarded"]))\n')
    edits['chattts_worker.py'] = worker
    render = (root / 'render').read_text()
    render = replace_once(render, '        echo "ChatTTS failed; falling back to Kokoro" >&2\n        render_kokoro "$KOKORO_LANG" "$KOKORO_VOICE"', '        echo "ChatTTS stopped; no automatic fallback. Use audio-briefing for long audio." >&2\n        exit 1')
    edits['render'] = render
    for name, source in edits.items():
        if name.endswith('.py'):
            ast.parse(source)
    for name in edits:
        original = root / name
        backup = root / (name + '.before-safety')
        if not backup.exists():
            shutil.copy2(original, backup)
    shutil.copy2(Path(__file__).with_name('chattts_safety.py'), root / 'chattts_safety.py')
    for name, source in edits.items():
        temporary = root / (name + '.safety-tmp')
        temporary.write_text(source)
        temporary.chmod((root / name).stat().st_mode)
        temporary.replace(root / name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('runtime', type=Path)
    install(parser.parse_args().runtime)
