# Progress
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
