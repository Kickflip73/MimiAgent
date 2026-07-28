# Progress
1. 目标：把当前 d537 M-1/M0 候选修成契约正确、可恢复提交、真实常驻的 M0 基线；不进入 M1。
2. 顺序：基线核对 → ActionIntent/Computer → Provider/资源/治理 → 全量门禁 → 全局安装重启 → 短观察 → 提交。
3. 最大风险：观察证据被当授权、同内容不同业务动作误去重、流式失败误记成功或切备重放、真实 Daemon 仍加载旧包。
4. 保护：uncertain 永不重放；真实数据不删；`knowledge/wiki/_log.md` 不修改、不暂存；不 push、不部署。
5. 2026-07-28 基线：`git diff --check` 通过；detached，57 个 tracked diff 文件；全局 `mimi` 指向全局包。
6. 当前 `npm run ci` 全绿：597/597、fail=0、skipped=0；coverage 85.31/76.15/82.24；build/package 通过。
7. 真实 Daemon PID 56498：Event/Task/Outbox/Host mutation 均无进行中副作用，协议 11，但仍未呈现新版状态字段。
8. ActionIntent/Computer 红→绿：旧实现 focused 44/46（误跨事件去重、observation 冒充授权）→ 46/46；check 通过。
9. 最终 CI 609/609、coverage 85.32/76.40/82.40；真实副本 build ffa3d8b247b5 已运行，Ledger v2 含原 95 条且 0 变更/0 丢失，Computer ready、unknown=0；owner 在约 6 分钟稳定观察后明确停止等待。
10. 新 P0 裁决：已停止安装/重启/提交；自由文本与 Shell 命令正则不得参与工具裁剪或授权，个人消息收窄仅接受结构化 PersonalMessage 事件。
11. Badcase 根因补丁：owner 文本路由/命令黑名单已移除；Darwin Shell 统一隔离 Apple Events、AX、LaunchServices 及已登记 Unix/loopback 控制端点，同时保留普通本地开发服务；Connector 增加稳定 capability/effect/routeOwner 与应用 claim；后台委派入队前校验 requiredCapabilities；Plan 外部完成绑定 confirmed ledger receipt，并锁定 completed step。
