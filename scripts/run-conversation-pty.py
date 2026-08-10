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
import stat
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
EVIDENCE_KINDS = {"fixture", "readiness", "live_action", "soak"}
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
MAX_CREDENTIAL_BYTES = 64 * 1024
EXACT_CONNECTOR_CONFIG = b'{"connectors":{}}\n'


class HelperTerminationRequested(BaseException):
    def __init__(self, signum):
        super().__init__(f"received signal {signum}")
        self.signum = signum


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def normalize(value):
    plain = ANSI_RE.sub(b"", value).replace(b"\r", b"\n")
    return plain.decode("utf-8", errors="replace")


def secret_values():
    declared = os.environ.get("MIMI_CONVERSATION_SECRET_NAMES", "")
    names = declared.split(",") if declared else []
    if len(names) != 1 or not ENV_NAME_RE.fullmatch(names[0]):
        raise RuntimeError("PTY requires exactly one valid declared Provider secret name")
    secret_name = names[0]
    file_name = os.environ.get("MIMI_ENV_FILE", "")
    if not file_name or not os.path.isabs(file_name) or os.path.abspath(file_name) != file_name:
        raise RuntimeError("PTY Provider credential path must be absolute and normalized")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(file_name, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError("PTY Provider credential is not a regular file")
        if stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1:
            raise RuntimeError("PTY Provider credential permissions or link count are invalid")
        if hasattr(os, "getuid") and before.st_uid != os.getuid():
            raise RuntimeError("PTY Provider credential owner is invalid")
        if before.st_size < 1 or before.st_size > MAX_CREDENTIAL_BYTES:
            raise RuntimeError("PTY Provider credential exceeds its byte bound")
        chunks = []
        total = 0
        while total <= MAX_CREDENTIAL_BYTES:
            chunk = os.read(descriptor, min(65536, MAX_CREDENTIAL_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        contents = b"".join(chunks)
        after = os.fstat(descriptor)
        if (
            total != before.st_size
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_mode != after.st_mode
            or before.st_nlink != after.st_nlink
        ):
            raise RuntimeError("PTY Provider credential changed while reading")
        current = os.lstat(file_name)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_dev != before.st_dev
            or current.st_ino != before.st_ino
            or current.st_nlink != 1
        ):
            raise RuntimeError("PTY Provider credential path changed while reading")
    finally:
        os.close(descriptor)

    if b"\x00" in contents or b"\r" in contents or not contents.endswith(b"\n"):
        raise RuntimeError("PTY Provider credential record is malformed")
    try:
        text = contents.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise RuntimeError("PTY Provider credential is not UTF-8") from error
    if text.count("\n") != 1:
        raise RuntimeError("PTY Provider credential must contain exactly one record")
    prefix = f"{secret_name}="
    record = text[:-1]
    if not record.startswith(prefix):
        raise RuntimeError("PTY Provider credential does not match the declared key")
    try:
        value = json.loads(record[len(prefix):])
    except json.JSONDecodeError as error:
        raise RuntimeError("PTY Provider credential value is not a JSON string") from error
    if not isinstance(value, str) or "\x00" in value or "\r" in value or "\n" in value:
        raise RuntimeError("PTY Provider credential value is invalid")
    encoded = value.encode("utf-8")
    if len(encoded) < 8 or len(encoded) > MAX_CREDENTIAL_BYTES:
        raise RuntimeError("PTY Provider credential value is outside its byte bound")
    return [encoded]


def redact(value, secrets):
    output = value
    hits = 0
    for secret in set(secrets):
        count = output.count(secret)
        if count:
            hits += count
            output = output.replace(secret, b"<redacted-provider-secret>")
    for pattern in SECRET_PATTERNS:
        output, count = pattern.subn(b"<redacted-secret-pattern>", output)
        hits += count
    return output, hits


def proof_passed(error, exit_code, startup_observed, secret_hits, model_actions):
    return (
        error is None
        and exit_code == 0
        and startup_observed
        and secret_hits == 0
        and len(model_actions) > 0
        and all(item["connectorIsolation"]["proven"] for item in model_actions)
        and all(item["modelRun"]["provenTerminal"] for item in model_actions)
    )


def control_passed(error, exit_code, startup_observed, secret_hits, action_results):
    return (
        error is None
        and exit_code == 0
        and startup_observed
        and secret_hits == 0
        and len(action_results) > 0
        and all(
            item["kind"] == "terminal_action"
            and isinstance(item.get("terminalAction"), dict)
            and item["terminalAction"].get("matched") is True
            for item in action_results
        )
        and action_results[-1]["terminalAction"].get("exited") is True
    )


def exclusive_write(file_name, data):
    descriptor = os.open(file_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        write_all(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent = os.path.dirname(file_name) or "."
    directory_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if hasattr(os, "O_DIRECTORY"):
        directory_flags |= os.O_DIRECTORY
    directory = os.open(parent, directory_flags)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--purpose", choices=("proof", "control"), default="proof")
    parser.add_argument("--actions", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--journal")
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


def validate_model_action(action, index, session_id):
    scenario_id = action.get("scenarioId")
    turn = action.get("turn")
    nonce = action.get("nonce")
    action_session = action.get("sessionId")
    evidence_kind = action.get("evidenceKind")
    if not isinstance(scenario_id, str) or not IDENTIFIER_RE.fullmatch(scenario_id):
        raise ValueError(f"model action {index} scenarioId is invalid")
    if isinstance(turn, bool) or not isinstance(turn, int) or turn < 1:
        raise ValueError(f"model action {index} turn is invalid")
    if not isinstance(nonce, str) or not IDENTIFIER_RE.fullmatch(nonce):
        raise ValueError(f"model action {index} nonce is invalid")
    if action_session != session_id:
        raise ValueError(f"model action {index} sessionId does not match the PTY Session")
    if evidence_kind not in EVIDENCE_KINDS:
        raise ValueError(f"model action {index} evidenceKind is invalid")


def read_actions(file_name, session_id, purpose="proof"):
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
        if action["kind"] == "model_turn":
            validate_model_action(action, index, session_id)
    if purpose == "control" and any(action["kind"] != "terminal_action" for action in value):
        raise ValueError("control purpose accepts only terminal_action records")
    if purpose == "proof" and not any(action["kind"] == "model_turn" for action in value):
        raise ValueError("proof purpose requires at least one model_turn")
    final_action = value[-1]
    if (
        final_action["kind"] != "terminal_action"
        or final_action["text"].strip() != "/exit"
        or final_action.get("waitForExit") is not True
    ):
        raise ValueError(f"{purpose} purpose must end with an explicit /exit waitForExit action")
    return value


def process_group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as error:
        raise RuntimeError("cannot verify the PTY child process group") from error


def wait_for_child_process_group(pid, deadline):
    while time.monotonic() < deadline:
        try:
            if os.getpgid(pid) == pid:
                return True
        except ProcessLookupError:
            return False
        time.sleep(0.01)
    return False


def wait_group_bounded(pid, deadline, leader_reaped=False):
    while time.monotonic() < deadline:
        if not leader_reaped:
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                leader_reaped = True
            except InterruptedError:
                continue
            else:
                leader_reaped = waited == pid
        if leader_reaped and not process_group_exists(pid):
            return True
        time.sleep(0.02)
    return False


def terminate_group(pid, grace_seconds=2.0):
    leader_reaped = False
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        leader_reaped = True
    except InterruptedError:
        waited = 0
    else:
        leader_reaped = waited == pid
    if leader_reaped:
        if not process_group_exists(pid):
            return
    else:
        try:
            child_group = os.getpgid(pid)
        except ProcessLookupError:
            child_group = None
        if child_group != pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if wait_group_bounded(pid, time.monotonic() + grace_seconds, leader_reaped):
                return
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if not wait_group_bounded(pid, time.monotonic() + grace_seconds, leader_reaped):
                raise TimeoutError("PTY child did not exit after direct SIGKILL")
            return
    if not process_group_exists(pid):
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        raise RuntimeError("cannot terminate the PTY child process group") from error
    if wait_group_bounded(pid, time.monotonic() + grace_seconds, leader_reaped):
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        raise RuntimeError("cannot kill the PTY child process group") from error
    if not wait_group_bounded(pid, time.monotonic() + grace_seconds, leader_reaped):
        raise TimeoutError("PTY child process group did not exit after SIGKILL")


def request_helper_termination(signum, _frame):
    raise HelperTerminationRequested(signum)


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


def append_dispatch_started(file_name, action):
    parent = os.path.dirname(os.path.abspath(file_name))
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(file_name, flags, 0o600)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            raise OSError("conversation journal is not a regular file")
        os.fchmod(descriptor, 0o600)
        record = {
            "kind": "turn_dispatch_started",
            "occurredAt": iso_now(),
            "scenarioId": action["scenarioId"],
            "turn": action["turn"],
            "nonce": action["nonce"],
            "sessionId": action["sessionId"],
            "evidenceKind": action["evidenceKind"],
            "denominatorEligible": False,
        }
        encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        write_all(descriptor, encoded)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def dispatch_action(master_fd, action, args):
    if action["kind"] == "model_turn":
        if not args.journal:
            raise ValueError("--journal is required for model_turn actions")
        append_dispatch_started(args.journal, action)
    submit_action(master_fd, action)


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


def assert_connector_isolation(command):
    if os.environ.get("MIMI_CONNECTORS_CONFIG_MODE") != "exact":
        raise RuntimeError("PTY requires exact Connector configuration mode")
    file_name = os.environ.get("MIMI_CONNECTORS_CONFIG", "")
    if not file_name or not os.path.isabs(file_name) or os.path.abspath(file_name) != file_name:
        raise RuntimeError("PTY Connector configuration path must be absolute and normalized")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(file_name, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError("PTY Connector configuration is not a regular file")
        if stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1:
            raise RuntimeError("PTY Connector configuration permissions or link count are invalid")
        if hasattr(os, "getuid") and before.st_uid != os.getuid():
            raise RuntimeError("PTY Connector configuration owner is invalid")
        if before.st_size != len(EXACT_CONNECTOR_CONFIG):
            raise RuntimeError("PTY Connector configuration is not exact-empty")
        contents = b""
        while len(contents) <= len(EXACT_CONNECTOR_CONFIG):
            chunk = os.read(descriptor, len(EXACT_CONNECTOR_CONFIG) + 1 - len(contents))
            if not chunk:
                break
            contents += chunk
        after = os.fstat(descriptor)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_mode != after.st_mode
            or before.st_nlink != after.st_nlink
        ):
            raise RuntimeError("PTY Connector configuration changed while reading")
        current = os.lstat(file_name)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_dev != before.st_dev
            or current.st_ino != before.st_ino
            or current.st_nlink != 1
        ):
            raise RuntimeError("PTY Connector configuration path changed while reading")
    finally:
        os.close(descriptor)
    if contents != EXACT_CONNECTOR_CONFIG:
        raise RuntimeError("PTY Connector configuration is not exact-empty")
    status = management_json(command, ["status", "--json"])
    if not isinstance(status, dict) or status.get("connectorCount") != 0:
        raise RuntimeError("PTY Daemon advertised one or more Connectors")
    return {
        "proven": True,
        "connectorCount": 0,
        "configSha256": hashlib.sha256(contents).hexdigest(),
    }


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
    actions = read_actions(args.actions, args.session_id, args.purpose)
    if any(action["kind"] == "model_turn" for action in actions) and not args.journal:
        raise ValueError("--journal is required for model_turn actions")
    # Validate and load the one selected secret before forking the PTY. A missing,
    # malformed, linked, or non-private credential must fail before any input can
    # reach Mimi or its Provider path. Secret bytes remain memory-only.
    secrets = secret_values()
    transcript = bytearray()
    action_results = []
    pid = None
    exit_code = None
    error = None
    startup_observed = False
    child_tty_checked = False
    master_fd = None
    started_at = iso_now()
    try:
        pid, master_fd = pty.fork()
        if pid == 0:
            if not os.isatty(0) or not os.isatty(1) or not os.isatty(2):
                os._exit(125)
            os.execvpe(args.command[0], args.command, os.environ)
        signal.signal(signal.SIGTERM, request_helper_termination)
        signal.signal(signal.SIGINT, request_helper_termination)
        if not wait_for_child_process_group(pid, time.monotonic() + 1.0):
            raise RuntimeError("PTY child does not own its process group")
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
            connector_isolation = None
            before_ids = set()
            if action["kind"] == "model_turn":
                # This gate is deliberately before the durable dispatch marker and
                # before writing any input to the PTY. A changed config or live
                # Connector therefore stops this turn at the Provider boundary.
                connector_isolation = assert_connector_isolation(args.command)
                before_ids = {item.get("id") for item in session_runs(args.command, args.session_id)}
            dispatch_action(master_fd, action, args)
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
                "connectorIsolation": connector_isolation,
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
            try:
                terminate_group(pid)
            except BaseException as cleanup_error:
                error = f"{error}; cleanup failed: {type(cleanup_error).__name__}: {cleanup_error}"
    finally:
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
    sanitized, secret_hits = redact(bytes(transcript), secrets)
    exclusive_write(args.transcript, sanitized)
    model_actions = [item for item in action_results if item["kind"] == "model_turn"]
    result = {
        "schemaVersion": 2,
        "kind": "mimi-persistent-pty-smoke" if args.purpose == "proof" else "mimi-pty-control-session",
        "purpose": args.purpose,
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
        "modelProofEligible": args.purpose == "proof" and proof_passed(
            error, exit_code, startup_observed, secret_hits, model_actions
        ),
    }
    result["passed"] = (
        result["modelProofEligible"]
        if args.purpose == "proof"
        else control_passed(error, exit_code, startup_observed, secret_hits, action_results)
    )
    exclusive_write(args.result, (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode())
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
