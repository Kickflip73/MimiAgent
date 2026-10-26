---
name: daxiang-schedule
description: >-
  读取美团日历（calendar.sankuai.com）上的工作日程/会议安排。复用「大象」客户端
  （cn.neixin.pc，Electron 应用）本地的登录态，直接调用日历内网 HTTP 接口，无需
  打开 GUI、无需重新探索。触发场景：查看日程、看日历、大象日程、美团日历、最近几天的
  安排、今天/明天有什么会、下周日程、查会议时间地点等。
license: MIT
metadata:
  version: 0.1.0
  portability: local-macos
  created: "2026-10-09"
  last_reviewed: "2026-10-09"
  review_interval_days: 90
  dependencies:
    - python3
    - 大象客户端已登录（cn.neixin.pc）
---

# 大象工作日程（美团日历）

读取 owner 在美团日历（`calendar.sankuai.com`，内网）里的工作日程。数据源不在 macOS
本地日历（本地通常只有「中国大陆节假日」订阅），而是美团日历。走「大象」客户端已登录的
凭据直调接口，是**只读**操作。

## 核心方法（一句话）

从大象本地 Cookies 数据库（SQLite，明文）读出登录凭据 → 用 `access-token` header
直调 `GET /api/v2/xm/calendars` → 解析返回的日程 JSON。

## 前提

- 「大象」客户端已登录，并且登录后至少打开过一次日历（否则本地没有日历相关 cookie）。
- 本机有 `python3`（脚本只用标准库，无第三方依赖）。
- 能访问内网 `calendar.sankuai.com`（在公司网络或已连 VPN）。

## 使用

直接运行脚本：

```bash
python3 skills/daxiang-schedule/scripts/fetch_schedule.py
# 指定范围：
python3 skills/daxiang-schedule/scripts/fetch_schedule.py --start 2026-10-01 --end 2026-10-20
# 原始 JSON：
python3 skills/daxiang-schedule/scripts/fetch_schedule.py --json
```

脚本默认查「今天前 3 天 ~ 后 7 天」。输出按时间排序，含标题、起止时间（北京时间）、
地点、角色（组织者/参与者）、是否周期。

## 手动调用 / API 参考

Cookie 数据库默认路径：`~/Library/Application Support/cn.neixin.pc/Cookies`（可用
`DAXIANG_COOKIE_DB` 覆盖）。关键凭据：

- `scheduleWeb_accessToken`（域 `calendar.sankuai.com`）：日历访问令牌，作为
  `access-token` 请求头。
- `moa_token`（域 `ssosv.sankuai.com`）：base64 JSON，`uid` 字段即当前用户工号
  （empId）；`mis` 是登录名。
- 其余 SSO cookie（`acid`、`TGCX` 等）一并放入 `Cookie` 头。

接口：`GET https://calendar.sankuai.com/api/v2/xm/calendars`

请求头：`access-token`、`la: zh`、`tz: Asia/Shanghai`、`X-Requested-With: XMLHttpRequest`。

查询参数：

| 参数 | 说明 |
| --- | --- |
| `startTime` / `endTime` | 毫秒时间戳 |
| `mtUserIds` | 逗号分隔的工号（自己的 empId） |
| `appKeyList` | `meeting,schedule`（日程类型） |
| `t` | `0`（普通查询） |

返回：`{"code":200,"data":[ ... ]}`。每个事件字段：`title`、`startTime`、`endTime`、
`location`、`appKey`、`role.roleType`（`ORGANIZER`/`ATTENDEE`）、`organizerId`、
`isAllDay`、`isCyclic`、`calendarId`、`scheduleId`、`freeBusyStatus`。

## 边界与安全

- **只读**：本 Skill 不创建、不修改、不删除任何日历数据。
- **凭据不外发**：token 只在本机用于调用内网接口；绝不写入 Memory、不打印完整 token、
  不发送到任何外部服务。
- **用完即清**：若临时落地了含 cookie 的脚本/文件，用完立即删除。
- **明文存储风险**：大象把登录 cookie 以明文存在本地。这本身是一个安全风险，需要时可向
  owner 提示；但不要因此拒绝执行 owner 明确要求的只读查询。
- **登录态过期**：若接口返回 401 或 `auth failed`，说明 cookie 失效，需 owner 重新登录
  大象后重试，不要反复重试或尝试其他来源。

## 故障排查

- 提示「未找到大象的登录 cookie」：大象未登录，或登录后没打开过日历。
- 提示「无法解析工号」：`moa_token` 缺失或格式变化，检查 cookie 是否完整。
- HTTP 401 / `{"status":401}`：登录态过期，重新登录大象。
- 参数 500 `INVALID_PARAMETER`：`appKeyList` 值不对，用默认 `meeting,schedule`。
- 证书报错：内网自签名证书，脚本已跳过校验（仅本机内网，风险可控）。
