#!/usr/bin/env python3
"""Call the injected local WeChat bridge without exposing its bearer token."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLIENT = ROOT / "build" / "mimi-wechat-bridge-client"
DEFAULT_TOKEN = Path.home() / ".mimi-agent" / "wechat-bridge" / "token"
LOCK_FILE = Path(os.environ.get(
    "MIMI_WECHAT_BRIDGE_LOCK_FILE",
    Path.home() / ".mimi-agent" / "wechat-bridge" / "bridge.lock",
))


def private_token(path: Path) -> str:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise RuntimeError("token_file_invalid")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise RuntimeError("token_file_permissions")
    value = path.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise RuntimeError("token_too_short")
    return value


@contextlib.contextmanager
def bridge_lock():
    """Serialize bridge calls so two workers cannot interleave UI events."""
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(LOCK_FILE.parent, 0o700)
    try:
        fd = os.open(
            LOCK_FILE,
            os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except OSError as error:
        raise RuntimeError("bridge_lock_invalid") from error
    try:
        metadata = os.fstat(fd)
        if metadata.st_uid != os.getuid() or (metadata.st_mode & 0o077) != 0:
            raise RuntimeError("bridge_lock_permissions")
        with os.fdopen(fd, "a+", encoding="utf-8", closefd=True) as lock_file:
            fd = -1
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError("bridge_busy") from error
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        if fd >= 0:
            os.close(fd)


def invoke(client: Path, request: dict[str, Any]) -> dict[str, Any]:
    completed = subprocess.run(
        [str(client), json.dumps(request, ensure_ascii=False)],
        capture_output=True,
        text=True,
        timeout=8,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip()[:500] or "bridge_call_failed")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("invalid_bridge_response") from error
    if not isinstance(response, dict):
        raise RuntimeError("invalid_bridge_response")
    return response


def main() -> int:
    parser = argparse.ArgumentParser(description="Call Mimi's local WeChat bridge")
    parser.add_argument("--action", choices=("status", "click", "type", "key"), required=True)
    parser.add_argument("--x", type=float)
    parser.add_argument("--y", type=float)
    parser.add_argument("--text")
    parser.add_argument("--key", choices=("return",))
    args = parser.parse_args()
    request: dict[str, Any] = {"action": args.action}
    if args.action == "click":
        if args.x is None or args.y is None or not 0 <= args.x <= 1 or not 0 <= args.y <= 1:
            raise RuntimeError("click_requires_normalized_coordinates")
        request.update(x=args.x, y=args.y)
    elif args.action == "type":
        if not args.text:
            raise RuntimeError("type_requires_text")
        request["text"] = args.text
    elif args.action == "key":
        request["key"] = args.key

    client = Path(os.environ.get("MIMI_WECHAT_BRIDGE_CLIENT", DEFAULT_CLIENT))
    token_path = Path(os.environ.get("MIMI_WECHAT_BRIDGE_TOKEN_FILE", DEFAULT_TOKEN))
    request["token"] = private_token(token_path)
    with bridge_lock():
        # A status round-trip is deliberately performed around every mutating
        # request.  The native bridge rejects an active clone as well, while
        # this second check catches a foreground transition between calls.
        if args.action != "status":
            before = invoke(client, {"action": "status", "token": request["token"]})
            if before.get("active") is True:
                print(json.dumps({"status": "failed", "error": "target_in_use"}, ensure_ascii=False))
                return 1
        response = invoke(client, request)
        if args.action != "status" and response.get("status") == "applied":
            after = invoke(client, {"action": "status", "token": request["token"]})
            if after.get("active") is True:
                print(json.dumps({"status": "uncertain", "error": "foreground_violation"}, ensure_ascii=False))
                return 2
    print(json.dumps(response, ensure_ascii=False))
    return 0 if response.get("status") in {"ready", "applied"} else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
