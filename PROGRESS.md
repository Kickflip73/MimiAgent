# Progress

## 2026-07-28 M1 current closeout

1. 正式实机门槛已达到：9 个 canary run 共 180 requested、123
   eligible/executed/success/qualifying、57 blocked、0 failed/uncertain，eligible
   execution success=100%，S0/S1/S2/S3=0。blocked 均未执行动作，保留在公开请求分母，
   不冒充成功。
2. 分层结果：Browser `34/34`、Computer `33/33`、Screen `27/27`、Shortcuts
   `29/29`，四个 App × 动作族 × 正式路径均为 100% eligible execution success。
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
7. 发布级 `npm run ci` 通过：644/644，skip/todo=0；coverage line 85.73%、
   branch 76.57%、function 83.11%，Build 与 package smoke 通过。
8. 运行态为 `0.12.0+09c805fcf95b`；Browser、Computer、Screen、Shortcuts 和其余
   已就绪本机通道保持正式门禁。`personal-daxiang` 因 owner target 未绑定诚实标记
   unavailable，不影响其他能力族验收。
9. 只读 24h soak 以最终构建 run `60bc4470-74bc-43ed-a0e3-cc88943be38b`
   (`2026-07-28T07:54:33.367Z`～`07:55:46.391Z`, 20/20) 为首样本，计划在
   `2026-07-29T07:55:46.391Z` 后验收。heartbeat `m1-24h` 每 4 小时只在运行态
   idle 时追加正式只读样本；忙时只记录 blocked，不抢占。
10. 部署前备份位于 `/tmp/mimi-backup-673b59f-20260728`，SQLite integrity、
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
