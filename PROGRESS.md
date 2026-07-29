# Progress

## 2026-07-28 M1 heartbeat blocked by runtime drift

1. `2026-07-28T12:22:34.171Z` heartbeat 观察到 Daemon 已从目标构建
   `0.12.0+9bf15be88f93` 变为 `0.12.0+316eb41416db`，并于
   `2026-07-28T12:07:07.169Z` 重新启动；因此 T0 建立的同构建连续 24h 窗口已中断。
2. 观察时还有 1 个 active Event（Task/Outbox/host mutation 均无活动），不满足
   idle 门禁。本轮没有执行只读 canary，没有重启、抢占、写动作、发送、前台激活
   或权限变更，也没有把 blocked 计为成功。
3. 工作区同时存在一组未提交的运行时开发改动，本 heartbeat 未修改或提交这些改动。
   只有这些改动形成可追溯提交、通过发布验证并部署为新的冻结构建后，才能重新建立
   M1 T0；原 run `ac47a076-956d-469d-b5b7-4a9036cf7947` 仍保留为历史成功证据，
   但不再满足最终构建连续 24h 的退出条件。
4. `2026-07-28T16:24:10.725Z` 再次观察时，Daemon 已于
   `2026-07-28T15:19:07.099Z` 重启为 `0.12.0+376bb1fbacc9`，且有 1 个 active
   Task worker。构建和 idle 门禁仍同时不满足，本轮继续只记录 blocked，没有执行
   canary 或干预该任务。
5. `2026-07-28T20:23:36.277Z` 观察时 Event/Task/Outbox/host mutation 已全部
   idle，但运行构建仍为 `0.12.0+376bb1fbacc9`，不等于 heartbeat 锁定构建
   `0.12.0+9bf15be88f93`。本轮因精确构建门禁失败继续 blocked，未执行 canary；
   idle 不能弥补构建连续性中断。
6. `2026-07-29T00:24:05.735Z` 观察时运行面继续 idle，Daemon 仍为
   `0.12.0+376bb1fbacc9`，没有新的冻结部署或 T0 证据。本轮继续因精确构建门禁
   blocked，未执行 canary，也未将旧 T0 或当前运行时计入 24h。
7. `2026-07-29T04:23:41.301Z` 观察到 Daemon 已于
   `2026-07-29T04:13:40.408Z` 再次重启为 `0.12.0+27e9a5182037`。运行面虽已
   idle，但工作区仍有未提交的 Daemon/Dispatcher 改动，既不匹配旧目标构建，也
   不能作为新的冻结基线；本轮继续 blocked，未执行 canary。
8. `2026-07-29T08:24:41.809Z` 观察到 Daemon 已于
   `2026-07-29T08:01:23.578Z` 重启为 `0.12.0+9ea51be56887`，并有 2 个 active
   Event；工作区还有大范围未提交运行时改动。精确构建和 idle 门禁均失败，本轮
   继续 blocked，未执行 canary、重启或抢占。

## 2026-07-28 M1 final runtime soak after owner-sensitive fix

1. owner 当前 Run 临时敏感值修复已合入并推送到完整集成分支
   `codex/mimiagent-integrated`，合并提交为 `3ed080e`。最终运行基线为
   `0.12.0+9bf15be88f93`；Daemon 已在无 active Event/Task/Outbox/host mutation
   的窗口安全重启，PID `27809`，运行 build 与当前产物一致。
2. Full Owner 状态已明确暴露 `ephemeralSensitiveModelAccess=true`。临时值仅允许
   “已认证直接 owner + Full Owner + 当前 Session/Run + 单次 15 分钟租约”进入
   Provider 输入；Safe、Workstation、外部 Event、SubAgent、Team、后台任务及其他
   Session 均不能继承。Session、Tool、Ledger、MCP、Connector、Trace、错误、流式
   输出和最终回答继续统一脱敏，不按业务关键词特判。
3. 最新构建首轮正式 canary run
   `ac47a076-956d-469d-b5b7-4a9036cf7947`
   (`2026-07-28T10:27:50.943Z`～`10:28:51.828Z`) 完成：
   20 requested/eligible/executed/success/qualifying，coverage=100%，eligible
   execution success=100%，blocked/failed/uncertain=0，S0/S1/S2/S3=0。
4. 分层结果为 Browser `5/5`、Computer `5/5`、Screen `5/5`、Shortcuts `5/5`；
   全部通过正式 ConnectorManager/ComputerManager 固定只读 probe，不含 direct
   worker、readiness 冒充、写动作、发送或前台激活。证据保存在
   `artifacts/m1-eval/canary-9bf15be88f93-t0.json`。
5. 最新构建的 24h 只读窗口从
   `2026-07-28T10:28:51.828Z`（北京时间 `2026-07-28 18:28:51`）起算，最早在
   `2026-07-29T10:28:51.828Z` 后终验。heartbeat `m1-24h` 已更新为每 4 小时在
   `/Users/liuyuran/Project/MimiAgent` 运行同构建正式 canary；忙时只记录 blocked，
   不抢占、不重启、不把 blocked 计为成功。
6. 发布级 `npm run ci` 已通过：674/674，skip/todo=0；coverage line 86.35%、
   branch 76.78%、function 82.77%，Build 与 package smoke 通过。升级前 Daemon
   备份位于 `/tmp/mimi-m1-rollout-20260728.vjfLI8/daemon-backup`，清单、摘要和
   SQLite integrity 已验证。历史 88 条已分类 dead letter 与未绑定
   `personal-daxiang` 保持为既有/外部问题，不误报为本次部署回归。

## 2026-07-28 process diagnosis permission Badcase

- 根因不是 SIP：Darwin `run_shell` 无条件进入 `sandbox-exec`，而 macOS 的
  `/bin/ps`、`/usr/bin/top` 带特权位，即使 profile 为 `allow default` 也会在 exec
  边界返回 `Operation not permitted`。
- 新增只读 `inspect_processes`：固定调用 `/bin/ps` argv，按 CPU/内存排序，最多返回
  50 条 PID、UID、RSS/VSZ、CPU/内存比例和 executable；不返回命令行参数，不支持
  signal、kill、注入、提权或 GUI 控制，也不需要 ActionIntent/逐次批准。
- Shell 保持一个简单边界：继续防止 Apple Events、Accessibility 和本机控制面绕过；
  同时启用 `pipefail`，管道中间失败不再表现为 `exitCode=0 + 空输出`。
- Agent 指令明确把 Shell `operation not permitted` 归因于 MimiAgent 自身沙箱，并优先
  使用已注册只读诊断能力；不得误报 SIP、反复换命令试探或直接把任务退回 owner。
- 修复已随构建 `0.12.0+b585e4b37ef5` 安装并安全重启 Daemon；真实 owner Run
  直接选择 `inspect_processes`，在 700 个进程中返回前 5 项并完成回答，没有尝试
  `ps`/`top`、误报 SIP 或要求 owner 手工执行。

## 2026-07-28 M1 current closeout

1. 正式实机门槛已达到：10 个 canary run 共 200 requested、129
   eligible/executed/success/qualifying、71 blocked、0 failed/uncertain，eligible
   execution success=100%，S0/S1/S2/S3=0。blocked 均未执行动作，保留在公开请求分母，
   不冒充成功。
2. 分层结果：Browser `36/36`、Computer `34/34`、Screen `28/28`、Shortcuts
   `31/31`，四个 App × 动作族 × 正式路径均为 100% eligible execution success。
3. Screen/Shortcuts 旧配置未迁移的根因是 live config 指向内容相同但路径不同的 managed
   script 副本；`673b59f` 以同名、普通文件、2MB 上限和 SHA-256 相等为门禁同步稳定
   action metadata，不改变 owner 的执行路径。
4. 无启动 status 的只读 Connector 不再陷入 readiness 自举死锁：只有已注册
   `effect=read` 动作真实成功后才建立 15 分钟 readiness 租约；显式 unavailable、
   write/unknown、route drift 和失败仍 fail closed。
5. M1 canary 的主机冲突门禁只判断 Event/Task/Outbox/host mutation；无关 Connector
   warning 不再误裁剪其他能力，目标能力仍由各自正式 Manager 独立校验。
6. CuaDriver 曾出现“进程和 socket 存在但客户端不响应”的假在线，后台精确重启后
   Accessibility/Screen Recording 均为 true，随后两轮各 `20/20` 全部成功。
7. 发布级 `npm run ci` 通过：646/646，skip/todo=0；coverage line 85.86%、
   branch 76.54%、function 83.06%，Build 与 package smoke 通过。为避免测试进程
   与真实 QQ 后台操作争用，CI 使用独立的 0700 临时锁目录；产品锁策略未改变。
8. 运行态为 `0.12.0+b585e4b37ef5`；Browser、Computer、Screen、Shortcuts 和其余
   已就绪本机通道保持正式门禁。`personal-daxiang` 因 owner target 未绑定诚实标记
   unavailable，不影响其他能力族验收。
9. 只读 24h soak 因运行时变化从新构建 run
   `587b8ad0-061c-40f3-b8c9-ed1d4dad8c18`
   (`2026-07-28T08:19:35.011Z`～`08:19:57.061Z`) 重新起算；本轮 6/6 实际动作
   成功且四类能力均有样本，14 项在并发忙门禁前 blocked。计划在
   `2026-07-29T08:19:57.061Z` 后验收。heartbeat `m1-24h` 每 4 小时只在运行态
   idle 时追加正式只读样本；忙时只记录 blocked，不抢占。
10. 本次部署前备份位于 `/tmp/mimi-process-fix-parent.p0Swnn/backup`，SQLite integrity、
    文件清单和摘要已校验；回滚仍必须在 Event/Task/Outbox/host mutation 全部 idle
    时执行。

## Previous checkpoint

1. 目标已落地：只有正式注册边界返回动作结果的 `live_action` 可计入 100 次；direct worker/readiness/blocked/uncertain 均不能晋级。
2. 证据 v2 已实现 `fixture|readiness|live_action|soak`、完整分母、分层报告、v1 明确迁移错误、原子并发/重复/uncertain 防重试。
3. 反向验证：证据测试先 0/9 红、后 9/9 绿；正式 probe 测试先 23/26 红、后 26/26 绿；最新聚焦 47/47。
4. fixture：60 requested，38 eligible/executed，24 success、22 blocked、11 failed、3 uncertain；qualifying live_action=0。
5. 正式 probe 已通过认证 Unix Socket、CapabilityResolver/Tool policy、ConnectorManager/ComputerManager；固定 read profile，拒绝 write/unknown/stale/漂移/控制面 App。
6. 最终 CI：640/640、skip/todo=0；coverage 85.59/76.54/82.98，高于给定基线 85.25/76.44/82.45（本机旧基线实测 85.24/76.43/82.42）。
7. 运行基线：Doctor ready、Connector 4/4 ready、Computer ready、unclassified=0；Daemon build `0.12.0+28a12e836691`，目标 build `0.12.0+4b45aa89825f`。
8. 安装门禁连续 3 轮均为 activeEvent=1、running=1；按 Goal 停止安装/重启/实机，不启用 Screen/Shortcuts，也不触发 TCC 或前台操作。
9. 本轮 canary 公开 20 requested、20 blocked、eligible/executed/success=0、coverage=0、qualifying=0、S0/S1=0；距 100 次仍差 100，95% 无可计算分母，24h soak 未开始。
10. 可复跑：运行态 idle 后先备份/校验，再安装目标 build，执行 `npm run eval:m1:canary -- --output <file> --build <build>`；旧 20 次仍按 0。

## 2026-07-28 Computer background ActionIntent Badcase

- 根因确认：M0 提交 `cd99619` 接入 ActionIntent 后，只给无 URL 的精确
  `launch_app` 声明 guarded 快速通道；正式 Ledger 下所有 Observation-bound
  click/type/scroll 即使 owner Run 已持有 `background` 能力也会在 Manager 前被拒绝。
- 修复最终收敛为轻量结构化授权：owner provenance、Run 的 background-or-higher
  grant、动作 background 三者同时成立即可进入快速通道；Observation 新鲜度、精确
  窗口、应用 route/allowlist 和前台保护由既有 ComputerManager 在执行时自动校验，
  不形成第二套模型授权条件，也不读取 Obsidian、按钮标题或自然语言关键词。
- 回归测试完整复现正式 `computer_observe → withExecutionLedger → computer_act`：
  修复前 0/1，错误为“缺少一次性授权”；修复后 Computer+Ledger 聚焦 55/55。
- 最终 `npm run ci` 通过：641/641，line 85.60%、branch 76.52%、
  function 83.01%，build 与 package smoke 均通过。
