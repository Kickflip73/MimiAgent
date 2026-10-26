#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
读取美团日历（calendar.sankuai.com）工作日程。

复用「大象」（Daxiang，cn.neixin.pc，Electron 应用）本地的登录态，
直接调用日历的内网 HTTP 接口，无需 GUI、不写日历、无外部依赖（仅 Python3 标准库）。

用法:
    python3 fetch_schedule.py                          # 默认：今天前 3 天 ~ 后 7 天
    python3 fetch_schedule.py --start 2026-10-01 --end 2026-10-20
    python3 fetch_schedule.py --json                   # 输出原始 JSON

环境变量:
    DAXIANG_COOKIE_DB    大象 Cookies 数据库路径（默认 ~/Library/Application Support/cn.neixin.pc/Cookies）
"""

import argparse
import base64
import json
import os
import sqlite3
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_URL = "https://calendar.sankuai.com/api/v2/xm/calendars"
DEFAULT_COOKIE_DB = os.path.expanduser(
    "~/Library/Application Support/cn.neixin.pc/Cookies"
)
TZ = timezone(timedelta(hours=8))  # Asia/Shanghai


def load_cookies(db_path):
    """读取大象本地 Cookies 数据库，返回 {host_key: {name: value}}。"""
    if not os.path.exists(db_path):
        return {}
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT host_key, name, value FROM cookies "
            "WHERE host_key LIKE '%calendar.sankuai.com%' "
            "   OR host_key LIKE '%ssosv.sankuai.com%'"
        ).fetchall()
    finally:
        conn.close()
    cookies = {}
    for host, name, value in rows:
        cookies.setdefault(host, {})[name] = urllib.parse.unquote(value)
    return cookies


def cookie_header(cookies):
    parts = []
    for names in cookies.values():
        for n, v in names.items():
            parts.append(f"{n}={v}")
    return "; ".join(parts)


def access_token(cookies):
    for names in cookies.values():
        if "scheduleWeb_accessToken" in names:
            return names["scheduleWeb_accessToken"]
    return None


def _b64_decode(s):
    s = s.strip()
    s += "=" * (-len(s) % 4)
    try:
        return base64.b64decode(s)
    except Exception:
        return base64.urlsafe_b64decode(s)


def emp_id(cookies):
    """从 SSO cookie 解析当前用户工号（moa_token -> uid）。"""
    for names in cookies.values():
        mt = names.get("moa_token")
        if not mt:
            continue
        b64 = mt.split("_", 1)[0]
        try:
            payload = json.loads(_b64_decode(b64))
        except Exception:
            continue
        if payload.get("uid"):
            return str(payload["uid"])
    # fallback: accessToken 尾部 base64 含 "empId,mis,name,..."
    tok = access_token(cookies)
    if tok and "**" in tok:
        tail = tok.rsplit("**", 1)[-1]
        try:
            first = _b64_decode(tail).decode("utf-8", "replace").split(",", 1)[0]
            if first.isdigit():
                return first
        except Exception:
            pass
    return None


def fetch_schedules(cookies, start_ms, end_ms, app_key_list="meeting,schedule"):
    eid = emp_id(cookies)
    if not eid:
        raise RuntimeError("无法从大象 cookie 解析工号 empId。")
    tok = access_token(cookies)
    if not tok:
        raise RuntimeError("未找到 scheduleWeb_accessToken，大象可能未登录日历。")

    params = urllib.parse.urlencode({
        "startTime": start_ms,
        "endTime": end_ms,
        "mtUserIds": eid,
        "appKeyList": app_key_list,
        "t": "0",
    })
    url = f"{API_URL}?{params}"
    headers = {
        "Cookie": cookie_header(cookies),
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 Chrome/120 Safari/537.36"
        ),
        "Accept": "application/json",
        "la": "zh",
        "tz": "Asia/Shanghai",
        "X-Requested-With": "XMLHttpRequest",
        "access-token": tok,
    }
    req = urllib.request.Request(url, headers=headers)
    # 内网自签名证书，跳过校验（不涉及跨网明文传输）。
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def fmt(ms):
    dt = datetime.fromtimestamp(ms / 1000, tz=TZ)
    return dt.strftime("%m-%d %H:%M") + f"（周{'一二三四五六日'[dt.weekday()]}）"


def render(events):
    lines = []
    for e in sorted(events, key=lambda x: x.get("startTime", 0)):
        title = e.get("title", "")
        loc = e.get("location") or ""
        st, en = e.get("startTime", 0), e.get("endTime", 0)
        if e.get("isAllDay"):
            ts = datetime.fromtimestamp(st / 1000, tz=TZ).strftime("%m-%d") + " 全天"
        else:
            ts = f"{fmt(st)} ~ {fmt(en)}"
        role = (e.get("role") or {}).get("roleType", "")
        tag = "组织者" if role == "ORGANIZER" else ("参与者" if role == "ATTENDEE" else "")
        cyc = " ·周期" if e.get("isCyclic") else ""
        lines.append(f"• {ts}  {title}{cyc}")
        if loc:
            lines.append(f"    地点: {loc}")
        if tag:
            lines.append(f"    我: {tag}")
    return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(description="读取美团日历（大象）工作日程")
    p.add_argument("--start", help="开始日期 YYYY-MM-DD")
    p.add_argument("--end", help="结束日期 YYYY-MM-DD")
    p.add_argument("--db", default=os.environ.get("DAXIANG_COOKIE_DB", DEFAULT_COOKIE_DB),
                   help="大象 Cookies 数据库路径")
    p.add_argument("--json", action="store_true", help="输出原始 JSON")
    p.add_argument("--app-key", default="meeting,schedule", help="appKeyList，默认 meeting,schedule")
    args = p.parse_args(argv)

    today = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    if args.start:
        start_dt = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=TZ)
        end_dt = (datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=TZ)
                  if args.end else start_dt + timedelta(days=7))
    else:
        start_dt = today - timedelta(days=3)
        end_dt = today + timedelta(days=7)

    cookies = load_cookies(args.db)
    if not cookies:
        print("错误：未找到大象的登录 cookie。请先登录大象并至少打开过一次日历。",
              file=sys.stderr)
        return 1

    try:
        resp = fetch_schedules(cookies,
                               int(start_dt.timestamp() * 1000),
                               int(end_dt.timestamp() * 1000),
                               args.app_key)
    except urllib.error.HTTPError as e:
        print(f"错误：HTTP {e.code}。登录态可能已过期，请重新登录大象后重试。",
              file=sys.stderr)
        return 1
    except Exception as e:
        print(f"错误：{e}", file=sys.stderr)
        return 1

    data = resp.get("data")
    if data is None:
        print(f"错误：API 返回异常：{json.dumps(resp, ensure_ascii=False)[:200]}",
              file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif not data:
        print(f"{start_dt:%m-%d} ~ {end_dt:%m-%d} 无日程。")
    else:
        print(f"共 {len(data)} 条日程（{start_dt:%m-%d} ~ {end_dt:%m-%d}）：\n")
        print(render(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
