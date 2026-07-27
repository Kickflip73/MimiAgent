#!/usr/bin/env python3
"""Send one QQ message through CuaDriver without bringing QQ to the front."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CUA_DRIVER = Path.home() / ".local" / "bin" / "cua-driver"
CUA_TIMEOUT_SECONDS = 10
NATIVE_HIDE_TIMEOUT_SECONDS = 8
CONTACT_SETTLE_TIMEOUT_SECONDS = 2.0
DRAFT_VERIFY_TIMEOUT_SECONDS = 2.0
SEND_VERIFY_TIMEOUT_SECONDS = 2.0
DEFAULT_CONTEXT_LIMIT = 20
MAX_CONTEXT_LIMIT = 100
MAX_CONTEXT_ITEM_CHARS = 2_000
MAX_CONTEXT_TOTAL_CHARS = 20_000
QQ_LOCK_FILE = Path(os.environ.get(
    "MIMI_QQ_LOCK_FILE",
    Path.home() / ".mimi-agent" / "qq-skill.lock",
))
NATIVE_VISIBILITY_SWIFT = r"""
import AppKit
let pid = pid_t(CommandLine.arguments[1])!
let action = CommandLine.arguments[2]
let before = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
let app = NSRunningApplication(processIdentifier: pid)
if action == "hide" { _ = app?.hide() } else { _ = app?.unhide() }
Thread.sleep(forTimeInterval: 0.35)
let after = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
print("{\"hidden\":\(app?.isHidden == true),\"frontmostUnchanged\":\(before == after)}")
"""


class SendError(RuntimeError):
    """A failure known not to have sent the message."""


class SendUncertain(RuntimeError):
    """A failure after the send action may have taken effect."""


class CuaDriver:
    def __init__(self, executable: str) -> None:
        self.executable = executable

    def call(
        self,
        tool: str,
        payload: dict[str, Any],
        *,
        allow_text: bool = False,
    ) -> dict[str, Any]:
        try:
            proc = subprocess.run(
                [self.executable, "call", tool, json.dumps(payload, ensure_ascii=False)],
                capture_output=True,
                text=True,
                timeout=CUA_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SendError(f"CuaDriver {tool} 调用失败：{error}") from error
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()
            raise SendError(f"CuaDriver {tool} 失败：{detail[:300]}")
        output = proc.stdout.strip()
        try:
            value = json.loads(output)
        except json.JSONDecodeError as error:
            if allow_text:
                return {"output": output} if output else {}
            raise SendError(f"CuaDriver {tool} 返回了无效 JSON") from error
        if not isinstance(value, dict):
            raise SendError(f"CuaDriver {tool} 返回类型无效")
        return value


@dataclass(frozen=True)
class Window:
    pid: int
    window_id: int


@dataclass(frozen=True)
class WindowLease:
    window: Window
    restore_hidden: bool


@contextlib.contextmanager
def qq_operation_lock():
    """Serialize every QQ CUA operation across Mimi workers and CLI calls."""
    QQ_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(QQ_LOCK_FILE.parent, 0o700)
    try:
        fd = os.open(
            QQ_LOCK_FILE,
            os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except OSError as error:
        raise SendError("QQ 后台锁文件不可安全打开；为避免并发操作，已停止") from error
    try:
        metadata = os.fstat(fd)
        if metadata.st_uid != os.getuid() or (metadata.st_mode & 0o077) != 0:
            raise SendError("QQ 后台锁文件权限不安全；为避免并发操作，已停止")
        with os.fdopen(fd, "a+", encoding="utf-8", closefd=True) as lock_file:
            fd = -1
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise SendError("QQ 后台通道正在执行另一项操作；为避免并发切换会话，已停止") from error
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        if fd >= 0:
            os.close(fd)


def text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def frame(element: dict[str, Any]) -> dict[str, float]:
    value = element.get("frame")
    return value if isinstance(value, dict) else {}


def coordinate(element: dict[str, Any], name: str) -> float:
    value = frame(element).get(name, 0)
    return float(value) if isinstance(value, (int, float)) else 0


def matches_contact(label: Any, contact: str) -> bool:
    candidate = text(label)
    return candidate == contact or (contact in candidate and len(candidate) <= len(contact) + 4)


def qq_app(
    driver: CuaDriver,
    expected_pid: int | None = None,
    *,
    require_inactive: bool = True,
) -> dict[str, Any]:
    listed = driver.call("list_apps", {})
    apps = listed.get("apps")
    candidates = [
        app for app in apps
        if isinstance(app, dict)
        and text(app.get("bundle_id")).lower() == "com.tencent.qq"
        and app.get("running") is not False
        and isinstance(app.get("pid"), int)
        and app.get("pid", 0) > 0
    ] if isinstance(apps, list) else []
    if expected_pid is not None:
        candidates = [app for app in candidates if app.get("pid") == expected_pid]
    if not candidates:
        if expected_pid is not None:
            raise SendError("QQ 进程在操作期间发生变化；为避免误操作，已停止")
        raise SendError("未找到运行中的 QQ")
    if require_inactive and any(app.get("active") is not False for app in candidates):
        raise SendError("无法证明 QQ 未占前台；为避免干扰你的操作，已停止")
    return candidates[0]


def assert_background_control(driver: CuaDriver, window: Window) -> None:
    qq_app(driver, window.pid)


def set_native_visibility(pid: int, action: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            ["/usr/bin/swift", "-e", NATIVE_VISIBILITY_SWIFT, str(pid), action],
            capture_output=True,
            text=True,
            timeout=NATIVE_HIDE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SendError(f"调整 QQ 后台窗口状态失败：{error}") from error
    if completed.returncode != 0:
        raise SendError("调整 QQ 后台窗口状态的原生辅助进程失败")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SendError("调整 QQ 后台窗口状态返回无效结果") from error
    if result.get("frontmostUnchanged") is not True:
        raise SendError("调整 QQ 后台窗口状态时前台应用发生变化")
    return result


def visible_qq_window(driver: CuaDriver, pid: int) -> Window | None:
    listed = driver.call("list_windows", {"pid": pid})
    windows = listed.get("windows")
    candidates = [
        item for item in windows
        if isinstance(item, dict)
        and item.get("pid") == pid
        and isinstance(item.get("window_id"), int)
        and item.get("is_on_screen") is True
        and item.get("on_current_space") is True
        and isinstance(item.get("bounds"), dict)
        and isinstance(item["bounds"].get("width"), (int, float))
        and isinstance(item["bounds"].get("height"), (int, float))
        and item["bounds"]["width"] >= 600
        and item["bounds"]["height"] >= 450
    ] if isinstance(windows, list) else []
    def window_rank(item: dict[str, Any]) -> float:
        bounds = item.get("bounds")
        area = 0.0
        if isinstance(bounds, dict):
            width = bounds.get("width", 0)
            height = bounds.get("height", 0)
            if isinstance(width, (int, float)) and isinstance(height, (int, float)):
                area = float(width * height)
        return area

    if not candidates:
        return None
    selected = max(candidates, key=window_rank)
    return Window(pid=selected["pid"], window_id=selected["window_id"])


def restore_hidden_window(driver: CuaDriver, window: Window) -> None:
    app = qq_app(driver, window.pid, require_inactive=False)
    if app.get("active") is not False:
        raise SendError("QQ 前台状态无法确认；不会隐藏用户正在使用的窗口")
    if os.environ.get("MIMI_QQ_USE_DRIVER_HIDE") == "1":
        driver.call("hotkey", {
            "pid": window.pid,
            "window_id": window.window_id,
            "keys": ["cmd", "h"],
            "delivery_mode": "background",
        }, allow_text=True)
    else:
        hidden = set_native_visibility(window.pid, "hide")
        if hidden.get("hidden") is not True or hidden.get("frontmostUnchanged") is not True:
            raise SendError("QQ 未能在保持前台应用不变的情况下恢复隐藏")
    app = qq_app(driver, window.pid, require_inactive=False)
    if app.get("active") is not False:
        raise SendError("恢复 QQ 隐藏状态时检测到前台占用；已停止")
    if visible_qq_window(driver, window.pid) is not None:
        raise SendError("QQ 后台窗口未能恢复原隐藏状态")


def acquire_qq_window(driver: CuaDriver, *, allow_visible_readonly: bool = False) -> WindowLease:
    app = qq_app(driver)
    pid = app["pid"]
    existing = visible_qq_window(driver, pid)
    if existing is not None:
        # A visible background QQ window is still the owner's real window.  A
        # conversation click would change what the owner sees next time they
        # switch to QQ (and may change read state), so the safe default is to
        # fail closed.  Tests/operators may explicitly opt in for a controlled
        # compatibility check, but production callers should keep this off.
        if not allow_visible_readonly and os.environ.get("MIMI_QQ_ALLOW_VISIBLE_BACKGROUND") != "1":
            raise SendError("QQ 窗口当前可见；为避免改变你看到的会话，后台操作已暂停")
        return WindowLease(window=existing, restore_hidden=False)

    launched = False
    window: Window | None = None
    try:
        if os.environ.get("MIMI_QQ_USE_DRIVER_HIDE") == "1":
            result = driver.call("launch_app", {
                "bundle_id": "com.tencent.qq",
                "creates_new_application_instance": False,
            })
        else:
            visibility = set_native_visibility(pid, "unhide")
            result = {
                "pid": pid,
                "self_activation_suppressed": visibility.get("frontmostUnchanged") is True,
            }
        launched = True
        if result.get("pid") not in {None, pid}:
            raise SendError("QQ 后台窗口租约返回了不同进程；已停止")
        if result.get("self_activation_suppressed") is not True:
            raise SendError("无法证明 QQ 后台窗口租约没有抢占前台；已停止")
        qq_app(driver, pid)
        deadline = time.monotonic() + CONTACT_SETTLE_TIMEOUT_SECONDS
        while window is None:
            window = visible_qq_window(driver, pid)
            if window is not None or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        if window is None:
            raise SendError("QQ 后台窗口租约未取得可操作窗口")
        return WindowLease(window=window, restore_hidden=True)
    except SendError:
        if launched:
            cleanup_window = window or visible_qq_window(driver, pid)
            if cleanup_window is not None:
                try:
                    restore_hidden_window(driver, cleanup_window)
                except SendError:
                    pass
        raise


def get_elements(driver: CuaDriver, window: Window) -> list[dict[str, Any]]:
    state = driver.call("get_window_state", {
        "pid": window.pid,
        "window_id": window.window_id,
        "include_screenshot": False,
    })
    elements = state.get("elements")
    if not isinstance(elements, list):
        raise SendError("QQ 窗口没有返回可用的无障碍元素")
    return [item for item in elements if isinstance(item, dict)]


def find_input(elements: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = [
        item for item in elements
        if item.get("role") == "AXTextArea"
        and coordinate(item, "w") >= 300
        and isinstance(item.get("element_token"), str)
    ]
    if not candidates:
        raise SendError("未找到 QQ 消息输入框（窗口可能已最小化或未打开聊天页）")
    return max(candidates, key=lambda item: (coordinate(item, "y"), coordinate(item, "w")))


def conversation_is_open(
    elements: list[dict[str, Any]],
    input_element: dict[str, Any],
    contact: str,
) -> bool:
    input_x = coordinate(input_element, "x")
    input_y = coordinate(input_element, "y")
    return any(
        item.get("role") == "AXButton"
        and matches_contact(item.get("label"), contact)
        and coordinate(item, "x") >= input_x
        and coordinate(item, "y") < input_y
        for item in elements
    )


def active_conversation_title(
    elements: list[dict[str, Any]],
    input_element: dict[str, Any],
) -> str:
    input_x = coordinate(input_element, "x")
    input_y = coordinate(input_element, "y")
    candidates = [
        item for item in elements
        if item.get("role") == "AXButton"
        and text(item.get("label"))
        and coordinate(item, "x") >= input_x
        and 0 < coordinate(item, "y") < min(input_y, 360)
        and coordinate(item, "w") >= 40
    ]
    excluded = {"聊天记录", "更多", "最小化", "最大化", "关闭"}
    candidates = [item for item in candidates if text(item.get("label")) not in excluded]
    if not candidates:
        raise SendError("无法识别当前 QQ 会话标题")
    selected = min(candidates, key=lambda item: (
        abs(coordinate(item, "x") - input_x),
        coordinate(item, "y"),
    ))
    return text(selected.get("label"))


def find_contact(
    elements: list[dict[str, Any]],
    input_element: dict[str, Any],
    contact: str,
) -> dict[str, Any]:
    input_x = coordinate(input_element, "x")
    input_y = coordinate(input_element, "y")
    candidates = [
        item for item in elements
        if item.get("role") in {"AXStaticText", "AXButton"}
        and matches_contact(item.get("label"), contact)
        and coordinate(item, "x") < input_x
        and coordinate(item, "y") < input_y
        and coordinate(item, "h") > 1
        and isinstance(item.get("element_token"), str)
    ]
    if not candidates:
        raise SendError(f'当前 QQ 会话列表中未找到联系人“{contact}”')
    exact = [item for item in candidates if text(item.get("label")) == contact]
    selected = exact or candidates
    labels = {text(item.get("label")) for item in selected}
    if len(labels) > 1:
        raise SendError(f'联系人“{contact}”匹配到多个昵称，请使用更精确的昵称')
    return min(selected, key=lambda item: (coordinate(item, "x"), coordinate(item, "y")))


def open_conversation(
    driver: CuaDriver,
    window: Window,
    elements: list[dict[str, Any]],
    contact: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    input_element = find_input(elements)
    if contact is None:
        return elements, input_element, active_conversation_title(elements, input_element)
    if conversation_is_open(elements, input_element, contact):
        return elements, input_element, active_conversation_title(elements, input_element)

    contact_element = find_contact(elements, input_element, contact)
    assert_background_control(driver, window)
    driver.call("click", {
        "pid": window.pid,
        "window_id": window.window_id,
        "element_token": contact_element["element_token"],
        "delivery_mode": "background",
    }, allow_text=True)

    deadline = time.monotonic() + CONTACT_SETTLE_TIMEOUT_SECONDS
    while True:
        elements = get_elements(driver, window)
        input_element = find_input(elements)
        if conversation_is_open(elements, input_element, contact):
            return elements, input_element, active_conversation_title(elements, input_element)
        if time.monotonic() >= deadline:
            raise SendError(f'无法确认已打开联系人“{contact}”的会话')
        time.sleep(0.1)


def message_count(
    elements: list[dict[str, Any]],
    input_element: dict[str, Any],
    message: str,
) -> int:
    input_x = coordinate(input_element, "x")
    input_y = coordinate(input_element, "y")
    return sum(
        item.get("role") == "AXStaticText"
        and text(item.get("label")) == message
        and coordinate(item, "x") >= input_x
        and coordinate(item, "y") < input_y
        for item in elements
    )


def input_is_clear(input_element: dict[str, Any]) -> bool:
    return not text(input_element.get("value")) and not text(input_element.get("label"))


def input_text(input_element: dict[str, Any]) -> str:
    return text(input_element.get("value")) or text(input_element.get("label"))


def context_messages(
    elements: list[dict[str, Any]],
    input_element: dict[str, Any],
    limit: int,
) -> tuple[list[dict[str, Any]], bool]:
    input_x = coordinate(input_element, "x")
    input_y = coordinate(input_element, "y")
    input_w = coordinate(input_element, "w")
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, float, float]] = set()
    for item in elements:
        original_value = text(item.get("label"))
        value = original_value[:MAX_CONTEXT_ITEM_CHARS]
        x = coordinate(item, "x")
        y = coordinate(item, "y")
        if (
            item.get("role") != "AXStaticText"
            or not value
            or x < input_x
            or y <= 300
            or y >= input_y
        ):
            continue
        fingerprint = (value, x, y)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        center = x + coordinate(item, "w") / 2
        relative_center = (center - input_x) / input_w if input_w > 0 else 0.5
        if re.fullmatch(r"(?:[01]?\d|2[0-3]):[0-5]\d", value):
            kind = "timestamp"
            direction = "unknown"
        elif relative_center <= 0.48:
            kind = "message"
            direction = "incoming"
        elif relative_center >= 0.60:
            kind = "message"
            direction = "outgoing"
        else:
            kind = "system"
            direction = "unknown"
        rows.append({
            "text": value,
            "kind": kind,
            "direction": direction,
            "_x": x,
            "_y": y,
            "_truncated": len(value) < len(original_value),
        })
    rows.sort(key=lambda item: (item["_y"], item["_x"]))
    truncated = len(rows) > limit or any(item["_truncated"] for item in rows)
    bounded = rows[-limit:]
    while bounded and sum(len(item["text"]) for item in bounded) > MAX_CONTEXT_TOTAL_CHARS:
        bounded.pop(0)
        truncated = True
    messages = [
        {key: value for key, value in item.items() if not key.startswith("_")}
        for item in bounded
    ]
    return messages, truncated


def read_qq_context(
    driver: CuaDriver,
    window: Window,
    contact: str | None,
    limit: int,
) -> dict[str, Any]:
    elements, input_element, resolved_contact = open_conversation(
        driver, window, get_elements(driver, window), contact,
    )
    assert_background_control(driver, window)
    messages, truncated = context_messages(elements, input_element, limit)
    return {
        "status": "context",
        "target": resolved_contact,
        "source": "visible_ax",
        "backgroundSafe": True,
        "complete": False,
        "truncated": truncated,
        "messages": messages,
    }


def qq_status(driver: CuaDriver, window: Window) -> dict[str, Any]:
    elements = get_elements(driver, window)
    input_element = find_input(elements)
    assert_background_control(driver, window)
    return {
        "status": "ready",
        "target": active_conversation_title(elements, input_element),
        "source": "visible_ax",
        "backgroundSafe": True,
    }


def send_qq_message(
    driver: CuaDriver,
    window: Window,
    contact: str,
    message: str,
    dry_run: bool,
) -> dict[str, Any]:
    elements, input_element, resolved_contact = open_conversation(
        driver, window, get_elements(driver, window), contact,
    )
    if dry_run:
        return {"status": "ready", "target": resolved_contact}

    if not input_is_clear(input_element):
        raise SendError("QQ 输入框已有内容；为避免覆盖用户草稿或重复发送，未执行任何写入")

    assert_background_control(driver, window)
    baseline = message_count(elements, input_element, message)
    token = input_element["element_token"]
    driver.call("type_text", {
        "pid": window.pid,
        "window_id": window.window_id,
        "element_token": token,
        "text": message,
        "delivery_mode": "background",
    }, allow_text=True)

    draft_deadline = time.monotonic() + DRAFT_VERIFY_TIMEOUT_SECONDS
    while True:
        prepared_elements = get_elements(driver, window)
        prepared_input = find_input(prepared_elements)
        if input_text(prepared_input) == message:
            break
        if time.monotonic() >= draft_deadline:
            raise SendError("QQ 输入框写入后内容不一致；为避免发送错误或重复文本，未执行发送按键")
        time.sleep(0.1)
    token = prepared_input["element_token"]
    assert_background_control(driver, window)

    try:
        driver.call("press_key", {
            "pid": window.pid,
            "window_id": window.window_id,
            "element_token": token,
            "key": "return",
            "delivery_mode": "background",
        }, allow_text=True)
        assert_background_control(driver, window)
    except SendError as error:
        raise SendUncertain(f"发送按键结果不确定：{error}") from error

    deadline = time.monotonic() + SEND_VERIFY_TIMEOUT_SECONDS
    while True:
        try:
            verified_elements = get_elements(driver, window)
            verified_input = find_input(verified_elements)
        except SendError as error:
            raise SendUncertain(f"发送后无法验证：{error}") from error
        if message_count(verified_elements, verified_input, message) > baseline:
            return {"status": "sent", "target": resolved_contact, "verified": True}
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    raise SendUncertain("发送动作已执行，但聊天区未出现新增消息；为避免重复发送，不会自动重试")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="后台读取 QQ 上下文或发送一条消息")
    parser.add_argument("--action", choices=("send", "context", "status"), default="send")
    parser.add_argument("--to", help="QQ 联系人昵称；读取当前会话时可省略")
    parser.add_argument("--msg", help="要发送的消息文本")
    parser.add_argument("--limit", type=int, default=DEFAULT_CONTEXT_LIMIT, help="上下文最大条目数")
    parser.add_argument("--dry-run", action="store_true", help="只验证联系人和会话，不发送")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    contact = args.to.strip() if isinstance(args.to, str) else None
    message = args.msg if isinstance(args.msg, str) else None
    if contact is not None and (not contact or len(contact) > 200):
        print(json.dumps({"status": "failed", "error": "联系人昵称无效"}, ensure_ascii=False))
        return 1
    if args.action == "send" and contact is None:
        print(json.dumps({"status": "failed", "error": "发送消息必须指定联系人"}, ensure_ascii=False))
        return 1
    if args.action == "send" and (not message or len(message) > 20_000):
        print(json.dumps({"status": "failed", "error": "消息必须为 1 到 20000 个字符"}, ensure_ascii=False))
        return 1
    if args.action == "context" and not 1 <= args.limit <= MAX_CONTEXT_LIMIT:
        print(json.dumps({"status": "failed", "error": "limit 必须为 1 到 100"}, ensure_ascii=False))
        return 1

    executable = os.environ.get("MIMI_CUA_DRIVER", str(DEFAULT_CUA_DRIVER))
    if not Path(executable).is_file():
        print(json.dumps({
            "status": "failed",
            "error": f"CuaDriver 不存在：{executable}",
        }, ensure_ascii=False))
        return 1

    try:
        with qq_operation_lock():
            driver = CuaDriver(executable)
            readonly_visible = args.action == "status" or (args.action == "context" and contact is None)
            lease = acquire_qq_window(driver, allow_visible_readonly=readonly_visible)
            operation_error: SendError | SendUncertain | None = None
            result: dict[str, Any] | None = None
            try:
                if args.action == "context":
                    result = read_qq_context(driver, lease.window, contact, args.limit)
                elif args.action == "status":
                    result = qq_status(driver, lease.window)
                else:
                    assert contact is not None and message is not None
                    result = send_qq_message(
                        driver, lease.window, contact, message, args.dry_run,
                    )
            except (SendError, SendUncertain) as error:
                operation_error = error
            cleanup_error: SendError | None = None
            if lease.restore_hidden:
                try:
                    restore_hidden_window(driver, lease.window)
                except SendError as error:
                    cleanup_error = error
            if operation_error is not None:
                raise operation_error
            assert result is not None
            if cleanup_error is not None:
                if result.get("status") == "sent":
                    result["backgroundSafe"] = False
                    result["cleanupWarning"] = str(cleanup_error)
                else:
                    raise cleanup_error
    except SendUncertain as error:
        print(json.dumps({"status": "uncertain", "error": str(error)}, ensure_ascii=False))
        return 2
    except SendError as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
