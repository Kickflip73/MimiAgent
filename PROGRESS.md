# Progress
1. 目标：先把 M-1/M0 收成真实绿色运行基线；M0 全部门禁实测通过前不得进入 M1。
2. 顺序：任务 0 核对 → JRV-001～008 证据矩阵 → 运行态安全收尾 → 全量 M0 验收 → 条件式 M1。
3. 最大风险：历史副作用被重放、活跃租约中重启、外部账号/权限缺失被伪装成 readiness、旧全局包冒充当前 build。
4. 保护：不删历史、不放宽健康定义、不猜授权/目标、不真实发送；uncertain 永不重放；真实数据变更前备份并 verify。
5. 起点：工作树干净，HEAD `444575b23bace4b52121be5debd3fc6366637dd7`，目标分支 ref 指向该提交；当前 worktree 为 detached HEAD。
6. 任务 0 CI 首跑：repo checks 通过，因本 worktree 无 `node_modules` 在 `tsc: command not found` 停止；正执行锁文件安装后重跑。
7. 任务 0 运行态：build `0.12.0+bb72ec858dd9`，Doctor `ready=false`，85 dead letter、unclassified=0、4 queued+1 running、Digest 78。
8. Connector：personal-qq offline；macos-life/personal-daxiang unavailable；unknown/stale=0；Computer ready。
9. 任务 0 时有 1 个活跃 Task worker，故延后重启；Task/Event/Outbox/Host mutation 全部归零后才完成安全重启。

## M-1 / M0 门禁矩阵

| Ref | 状态 | 本轮证据 |
|---|---|---|
| M-1 / JRV-001 Secret 与生命周期 | 通过（轮换外部阻塞） | 新增 Multica token fixture；dry-run 96 命中；备份 verify/integrity=ok；迁移 50 个 DB 值；复扫 0；轮换见 `BLOCKED.md` |
| JRV-002 Dead letter / Digest / CI / backup | 通过 | 85 dead letter 全分类、unclassified=0、不可变历史保留；Digest 80 未达风险阈值；最终 CI 621/621、skipped=0、coverage 85.17/76.46/82.39；备份 verify=ok |
| JRV-003 Effective Capability Snapshot | 通过 | `/status` 的 Skill 数取自同一 snapshot；自动化核对最终 Tool 摘要、Skill items 与 snapshot digest |
| JRV-004 ActionIntent Fence | 通过 | 既有跨 Tool/Provider/route 防重、一次性授权、uncertain 禁止换路测试随全量 CI 通过 |
| JRV-005 Provider 熔断/主备 | 通过 | 429、余额、网络、5xx 分类；half-open；stream/副作用开始后不切换测试随全量 CI 通过 |
| JRV-006 Readiness / coverage | 通过 | Doctor `ready=true`；启用 4/在线 4/ready 4；unknown/stale/unavailable=0；Computer ready |
| JRV-007 GUI 绕过 | 通过 | Darwin Shell 隔离、Connector routeOwner、Computer 控制面与 personal-message 无 Browser/Computer/Shell fallback 测试通过 |
| JRV-008 资源 SLO | 通过 | Doctor storage database/logs/memory=ok；Run/Token/费用/host unknown 语义与预算测试通过 |
| M0 红→绿反证 | 通过 | enable `personal-qq` 后 Doctor `ready=false`；disable 并过启动宽限期后 `ready=true`, issues=[] |
| M0 build identity | 通过 | 最终 CI 后再次确认 Event/Task/Outbox/Host mutation 无活跃租约；安全重启后 Daemon 与当前产物均为 `0.12.0+28a12e836691` |

## M1 JRV-102

- 已进入：M0 全量门禁先于 M1 实施通过。
- 已完成代码：Daxiang allowlist binding 固定 `selectedBy=owner + accountFingerprint + stable sid + type + authorizationRevision`；当前验证账号/网页会话不存在唯一候选时 `target_not_bound`。
- 已完成安全面：bounded read + Draft 保留；通用 Connector 写被拒；OpenAI/DeepSeek 共用 no-fallback fixture；页面/账号失效 fail closed；post-click timeout 只 commit 一次并返回 uncertain。
- 门禁红→绿：新增测试先 8/15 pass、7 fail（binding schema 未实现）→ 实现后聚焦 38/38、skipped=0；未执行真实绑定、发送或 soak。

## M1 JRV-101/102 验收基线（2026-07-28）

- Task 0 起点：新 worktree 在 `c4e3e4a` detached HEAD，工作树干净；已切到
  `codex/mimiagent-m1-eval-baseline`。`knowledge/wiki/_log.md` 为 tracked 且无本轮
  修改，继续列入禁止触碰项。
- CI 基线首跑：repo checks 通过，但 worktree 无 `node_modules`，在
  `tsc: command not found` 停止；`npm ci` 按现有锁文件安装 115 packages 后，
  基线 `npm run ci` 通过，coverage 85.16/76.45/82.39，未修改依赖或锁文件。
- 运行态基线：全局 Daemon build `0.12.0+28a12e836691`；Doctor `ready=true`,
  `issues=[]`；Connector enabled/online/ready=4/4/4，unknown/stale/unavailable=0；
  Computer/CUA ready。历史 85 dead letter 保留且 unclassified=0；Task queued=4、
  blocked=1、running=0，Event/worker/Outbox/host mutation 均 idle。
- Eval 基础设施：新增 manifest/schema v1、原子 run 文件、损坏输入拒绝、并发写、
  uncertain 禁止 retry 和分层 report；报告固定按 App × action family × execution path
  给 denominator、首次/重试/接管和 S0-S3。
- Fixture dataset：当前 60 个互不重复场景，覆盖 Computer、Browser、Screen、
  Shortcuts、Daxiang；runner 以相关 `node:test` 公共边界执行并以测试输出摘要作为
  脱敏 evidence ref，不直接把 manifest 标绿。
- 执行面元数据：Browser、Screen、Shortcuts、Desktop、Daxiang 的 M1 action 均固定
  capability/effect；route owner 仍由 Connector ID 结构化生成。`run_shortcut`、
  screen 显式落盘和 GUI/clipboard 输入均为 write，不再以 unknown 绕过门禁。
- 反向故障注入：测试把 Daxiang post-click `uncertain` 记录改成 retry 时 schema
  必然报错；恢复为 first attempt 后通过。该证据只证明 eval 门禁，不代表真实发送。
- 实机只读 canary：在 Doctor ready 且 Event/active Task/Outbox/host mutation 全 idle 后
  执行到本轮上限 20 次，覆盖 4 个 App × 动作族 × 路径。Computer readiness 5/5、
  Shortcuts catalog 5/5；Browser tabs 0/5（直接只读 worker 不可用，blocked）；
  Daxiang binding 0/5（disabled/target_not_bound，blocked）。总体 success=10、
  blocked=10、failed/uncertain=0、S0/S1=0；未触发前台切换、TCC、发送、截图或 OCR，
  也未保留标题、URL、快捷指令名或正文。由于只有 2 个组合实际成功，“至少 4 个可用
  组合”尚未达标；达到 20 上限后未继续补跑。
- 未关闭差额：尚未累计 100 次分层实机、95% 成功率、只读 24h 或发送 72h；真实
  Daxiang target/authorization 仍见 `BLOCKED.md`。本增量不得据此宣布 M1 全绿。
- 本增量最终 CI：`npm run ci` 为 628/628 pass，fail/skipped/todo=0；coverage
  lines 85.25%、branches 76.44%、functions 82.45%；Build 与 packed-package smoke
  通过。没有安装或重启 Daemon；运行态继续使用已验收的
  `0.12.0+28a12e836691`，本提交只交付下一次安全安装可使用的源码与评测基线。

## 最终验收

- `npm run ci`：621/621 pass，fail/skipped/todo=0；coverage lines 85.17、branches 76.46、functions 82.39；build 与 packed-package smoke 通过。
- 最终运行态：Doctor `ready=true`, `issues=[]`；enabled/online/ready=4/4/4；unknown/stale/unavailable=0；unclassified=0；Computer ready。
- 最终敏感历史 dry-run：valuesScanned=2281、findings=0、fingerprints=0、rawValuesIncluded=false。
- 历史 85 dead letter 按分类原样保留并继续显示 warning；Doctor 仅在 unclassified=0 且其他硬风险清零后 ready，未删除历史、未放宽诊断。
