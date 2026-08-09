#!/usr/bin/env python3
"""Drive the built Mimi CLI through one real, persistent stdlib PTY.

Model turns are never completed by matching input echo. Each turn must expose a
new terminal Daemon Run for the configured Session, positive Provider usage,
and a busy-to-prompt-ready UI transition. The TypeScript runner separately
proves Session protocol units, Trace order, and assistant output.
"""

import argparse
import datetime
import hashlib
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time


ANSI_RE = re.compile(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
SECRET_PATTERNS = [
    re.compile(rb"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(rb"\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b", re.IGNORECASE),
]
TERMINAL_RUN_STATES = {"completed", "failed", "interrupted"}
BUSY_MARKER = "运行中"
PROMPT_READY_MARKER = "· 模式 "
BRACKETED_PASTE_START = b"\x1b[200~"
BRACKETED_PASTE_END = b"\x1b[201~"


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def normalize(value):
    plain = ANSI_RE.sub(b"", value).replace(b"\r", b"\n")
    return plain.decode("utf-8", errors="replace")


def secret_values():
    names = os.environ.get("MIMI_CONVERSATION_SECRET_NAMES", "").split(",")
    return [os.environ.get(name, "").encode() for name in names if os.environ.get(name, "")]


def redact(value):
    output = value
    hits = 0
    for secret in set(secret_values()):
        if len(secret) < 8:
            continue
        count = output.count(secret)
        if count:
            hits += count
            output = output.replace(secret, b"<redacted-provider-secret>")
    for pattern in SECRET_PATTERNS:
        output, count = pattern.subn(b"<redacted-secret-pattern>", output)
        hits += count
    return output, hits


def exclusive_write(file_name, data):
    descriptor = os.open(file_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--actions", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--session-id", default=os.environ.get("MIMI_SESSION", ""))
    parser.add_argument("--startup-timeout-ms", type=int, default=30000)
    parser.add_argument("--max-transcript-bytes", type=int, default=32 * 1024 * 1024)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if len(args.command) < 2:
        parser.error("the Node executable and dist/index.js are required after --")
    if not args.session_id:
        parser.error("--session-id or MIMI_SESSION is required")
    return args


def read_actions(file_name):
    with open(file_name, "r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, list) or not value:
        raise ValueError("actions must be a non-empty JSON array")
    for index, action in enumerate(value):
        if not isinstance(action, dict) or not isinstance(action.get("text"), str):
            raise ValueError(f"action {index} must contain text")
        action.setdefault("kind", "model_turn")
        if action["kind"] not in {"model_turn", "terminal_action"}:
            raise ValueError(f"action {index} kind is invalid")
        if "\x1b" in action["text"] or "\r" in action["text"]:
            raise ValueError(f"action {index} contains terminal control bytes")
        if action["kind"] == "model_turn" and (
            BUSY_MARKER in action["text"] or PROMPT_READY_MARKER in action["text"]
        ):
            raise ValueError(f"model action {index} contains a PTY state marker")
        wait_for = action.get("waitFor")
        if wait_for and wait_for in action["text"]:
            raise ValueError(f"action {index} waitFor occurs in its input echo")
        if action["kind"] == "model_turn" and wait_for:
            raise ValueError(f"model action {index} cannot use textual waitFor completion")
    return value


def terminate_group(pid, grace_seconds=2.0):
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return
        time.sleep(0.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def drain(master_fd, transcript, max_bytes, timeout=0.1):
    ready, _, _ = select.select([master_fd], [], [], timeout)
    if not ready:
        return False
    try:
        chunk = os.read(master_fd, 65536)
    except OSError:
        chunk = b""
    if not chunk:
        return False
    transcript.extend(chunk)
    if len(transcript) > max_bytes:
        raise RuntimeError("PTY transcript exceeded the configured byte bound")
    return True


def write_all(descriptor, value):
    remaining = memoryview(value)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("PTY write made no progress")
        remaining = remaining[written:]


def submit_action(master_fd, action):
    encoded = action["text"].encode("utf-8")
    if action["kind"] == "model_turn" and b"\n" in encoded:
        write_all(master_fd, BRACKETED_PASTE_START)
        write_all(master_fd, encoded)
        write_all(master_fd, BRACKETED_PASTE_END)
        # InteractiveTerminal consumes a bracketed-paste chunk as one editor
        # update. Keep Enter in a later PTY read so it cannot be discarded as
        # bytes trailing the paste-end marker.
        time.sleep(0.05)
        write_all(master_fd, b"\r")
        return
    write_all(master_fd, encoded + b"\r")


def wait_startup(master_fd, transcript, timeout_ms, max_bytes):
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        drain(master_fd, transcript, max_bytes, 0.1)
        visible = normalize(bytes(transcript))
        if "MimiAgent v" in visible and PROMPT_READY_MARKER in visible:
            return True
    return False


def management_json(command, args, timeout=5):
    completed = subprocess.run(
        command[:2] + ["daemon"] + args,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env=os.environ,
    )
    return json.loads(completed.stdout.decode("utf-8"))


def session_runs(command, session_id):
    value = management_json(command, ["runs", "100"])
    if not isinstance(value, list):
        raise RuntimeError("daemon runs did not return an array")
    return [item for item in value if isinstance(item, dict) and item.get("sessionKey") == session_id]


def usage_from(run):
    answer = run.get("answer") if isinstance(run, dict) else None
    usage = answer.get("usage") if isinstance(answer, dict) else None
    if not isinstance(usage, dict):
        return 0, 0
    input_tokens = usage.get("runInputTokens", usage.get("inputTokens", 0))
    output_tokens = usage.get("runOutputTokens", usage.get("outputTokens", 0))
    return (
        input_tokens if isinstance(input_tokens, (int, float)) else 0,
        output_tokens if isinstance(output_tokens, (int, float)) else 0,
    )


def wait_model_turn(master_fd, transcript, start_offset, args, before_ids, timeout_ms):
    deadline = time.monotonic() + timeout_ms / 1000
    read_events = 0
    run_summary = None
    run_detail = None
    next_poll = 0.0
    while time.monotonic() < deadline:
        if drain(master_fd, transcript, args.max_transcript_bytes, 0.1):
            read_events += 1
        now = time.monotonic()
        if now >= next_poll:
            next_poll = now + 0.2
            fresh = [item for item in session_runs(args.command, args.session_id)
                     if item.get("id") not in before_ids]
            if len(fresh) > 1:
                raise RuntimeError("one PTY model action created more than one Daemon Run")
            if fresh and fresh[0].get("status") in TERMINAL_RUN_STATES:
                run_summary = fresh[0]
                run_detail = management_json(args.command, ["show", "run", run_summary["id"]])
        if run_summary is None:
            continue
        visible = normalize(bytes(transcript[start_offset:]))
        busy_at = visible.find(BUSY_MARKER)
        ready_at = visible.rfind(PROMPT_READY_MARKER)
        if busy_at >= 0 and ready_at > busy_at:
            break
    if run_summary is None or run_detail is None:
        raise TimeoutError("PTY model action did not expose an independent terminal Daemon Run")
    input_tokens, output_tokens = usage_from(run_detail)
    status = run_summary.get("status")
    visible = normalize(bytes(transcript[start_offset:]))
    busy_at = visible.find(BUSY_MARKER)
    ready_at = visible.rfind(PROMPT_READY_MARKER)
    prompt_ready = busy_at >= 0 and ready_at > busy_at
    return {
        "daemonRunId": run_summary.get("id"),
        "taskId": run_summary.get("taskId"),
        "status": status,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "promptReadyAfterBusy": prompt_ready,
        "readEvents": read_events,
        "transportChunksObserved": read_events >= 2,
        "provenTerminal": status == "completed" and input_tokens > 0 and output_tokens > 0 and prompt_ready,
    }


def wait_terminal_action(master_fd, transcript, start_offset, action, args):
    if action.get("waitForExit") is True:
        deadline = time.monotonic() + int(action.get("timeoutMs", 15000)) / 1000
        while time.monotonic() < deadline:
            drain(master_fd, transcript, args.max_transcript_bytes, 0.1)
            waited, status = os.waitpid(args.child_pid, os.WNOHANG)
            if waited == args.child_pid:
                return {"matched": True, "exitCode": os.waitstatus_to_exitcode(status), "exited": True}
        raise TimeoutError("terminal action did not exit")
    wait_for = action.get("waitFor")
    if not isinstance(wait_for, str) or not wait_for:
        raise ValueError("terminal_action requires waitFor or waitForExit")
    deadline = time.monotonic() + int(action.get("timeoutMs", 15000)) / 1000
    while time.monotonic() < deadline:
        drain(master_fd, transcript, args.max_transcript_bytes, 0.1)
        if wait_for in normalize(bytes(transcript[start_offset:])):
            return {"matched": True, "exited": False}
    raise TimeoutError(f"terminal action did not observe {wait_for!r}")


def main():
    args = parse_args()
    actions = read_actions(args.actions)
    transcript = bytearray()
    action_results = []
    pid = None
    exit_code = None
    error = None
    startup_observed = False
    child_tty_checked = False
    started_at = iso_now()
    try:
        pid, master_fd = pty.fork()
        if pid == 0:
            if not os.isatty(0) or not os.isatty(1) or not os.isatty(2):
                os._exit(125)
            os.execvpe(args.command[0], args.command, os.environ)
        args.child_pid = pid
        child_tty_checked = True
        startup_observed = wait_startup(
            master_fd, transcript, args.startup_timeout_ms, args.max_transcript_bytes
        )
        if not startup_observed:
            raise TimeoutError("persistent Mimi PTY did not render a ready startup prompt")
        for index, action in enumerate(actions):
            action_start = len(transcript)
            action_started_at = iso_now()
            before_ids = {item.get("id") for item in session_runs(args.command, args.session_id)}
            submit_action(master_fd, action)
            model_run = None
            terminal_action = None
            if action["kind"] == "model_turn":
                model_run = wait_model_turn(
                    master_fd,
                    transcript,
                    action_start,
                    args,
                    before_ids,
                    int(action.get("timeoutMs", 120000)),
                )
                if not model_run["provenTerminal"]:
                    raise RuntimeError(f"PTY model action {index + 1} failed its Run/usage/prompt-ready gate")
            else:
                terminal_action = wait_terminal_action(master_fd, transcript, action_start, action, args)
                if terminal_action.get("exited"):
                    exit_code = terminal_action.get("exitCode")
            action_results.append({
                "index": index + 1,
                "kind": action["kind"],
                "startedAt": action_started_at,
                "completedAt": iso_now(),
                "startRawOffset": action_start,
                "endRawOffset": len(transcript),
                "modelRun": model_run,
                "terminalAction": terminal_action,
            })
            if exit_code is not None:
                if index != len(actions) - 1:
                    raise RuntimeError("PTY exited before every declared action was proven")
                break
        if exit_code is None:
            raise RuntimeError("actions must end with an explicit /exit terminal_action")
    except BaseException as caught:
        error = f"{type(caught).__name__}: {caught}"
        if pid:
            terminate_group(pid)
    sanitized, secret_hits = redact(bytes(transcript))
    exclusive_write(args.transcript, sanitized)
    model_actions = [item for item in action_results if item["kind"] == "model_turn"]
    result = {
        "schemaVersion": 2,
        "kind": "mimi-persistent-pty-smoke",
        "tty": True,
        "childTtyChecked": child_tty_checked,
        "startupObserved": startup_observed,
        "startedAt": started_at,
        "completedAt": iso_now(),
        "exitCode": exit_code,
        "secretHits": secret_hits,
        "transcriptBytes": len(sanitized),
        "transcriptSha256": hashlib.sha256(sanitized).hexdigest(),
        "actions": action_results,
        "error": error,
        "passed": error is None
        and exit_code == 0
        and startup_observed
        and secret_hits == 0
        and len(model_actions) > 0
        and all(item["modelRun"]["provenTerminal"] for item in model_actions),
    }
    exclusive_write(args.result, (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode())
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
