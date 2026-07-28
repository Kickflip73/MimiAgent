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

## 最终验收

- `npm run ci`：621/621 pass，fail/skipped/todo=0；coverage lines 85.17、branches 76.46、functions 82.39；build 与 packed-package smoke 通过。
- 最终运行态：Doctor `ready=true`, `issues=[]`；enabled/online/ready=4/4/4；unknown/stale/unavailable=0；unclassified=0；Computer ready。
- 最终敏感历史 dry-run：valuesScanned=2281、findings=0、fingerprints=0、rawValuesIncluded=false。
- 历史 85 dead letter 按分类原样保留并继续显示 warning；Doctor 仅在 unclassified=0 且其他硬风险清零后 ready，未删除历史、未放宽诊断。
