# Blocked

- **2026-07-30 多 Provider Review 修复：当前无实施 blocker。** 开工时的 detached
  HEAD 已安全切换到既有任务分支 `codex/multimodel-review-fixes`；依赖安装未产生
  package/lockfile 或 tracked dist 改动。真实部署/canary 仍严格服从运行面 idle、
  备份、显式 credential 与低成本门禁。最终两个已配置 target、Session/route/Team
  canary 均通过；无 imageOutput 的媒体 canary 在 Provider 前诚实 blocked。
- **2026-07-30 本轮范围外运行告警（非交付阻塞）**：部署后 Doctor 的 `ready=false`
  由既有 112 个 Task dead letter、253 个 Digest backlog、3 个 Connector startup
  readiness unknown，以及 personal-daxiang 仍指向其他 checkout 的托管脚本构成。
  本任务未修改 Connector/M1/Memory 状态，也未重放 dead letter 或清理 backlog。
- **2026-07-30 任务 0 环境差异（非实施阻塞）**：HEAD 精确匹配
  `d01a6b78cc930dffd7179d6d48ae28c9cdaf0259`，开工工作树干净；
  `codex/multimodel-review-fixes` 指向同一提交，但当前 worktree 为 detached HEAD。
  本 worktree 缺少 `node_modules/.bin/tsx` 和 `node_modules/.bin/tsc`，按任务书仅因此
  执行 `npm ci`；若 lockfile 或生成物出现跟踪 diff，将停止受影响部分并保留证据。
- **2026-07-29 多模型分层路由实现及真实 Daemon 验收：无。**
- **2026-07-29 多模型任务 0 环境差异（非实施阻塞）**：
  `git branch --show-current` 为空，但补充核实这是
  `create_thread(startingState=working-tree)` 独立 worktree 的预期状态；`HEAD`、本地
  `codex/mimiagent-integrated` 与 `origin/codex/mimiagent-integrated` 均为
  `cc362de19453a03230c19c118a775171e154eea2`。不切分支、不提交或推送，并保留继承
  的脏改动。首次 `npm run check` exit 127，
  原始错误为 `sh: tsc: command not found`，说明此 worktree 尚未安装本地依赖；
  `npm ci` 后 `npm run check` 已通过。首次 `npm test` 实际为
  `tests 726 / pass 720 / fail 6 / skipped 0`，不等于规格记录的 726/726：
  `tests/computer.test.ts` 一项 fake Cua `--version` 进程被 SIGTERM，
  `tests/qq-messenger-skill.test.ts` 五项观察到共享 QQ 后台通道忙。两组都在本任务
  实现白名单之外；随后聚焦复跑实际为 `tests 40 / pass 40 / fail 0 / skipped 0`，
  确认为一次性环境争用，不会为通过基线修改越界代码。
- **M1.1 等待运行时重新冻结并重启 24h 日历 soak**：历史正式实机已累计 129/129
  成功；构建 `0.12.0+9bf15be88f93` 的首轮正式 canary 完成 20/20，
  Browser/Computer/Screen/Shortcuts 各 5/5，blocked/failed/uncertain=0，
  S0/S1/S2/S3=0。原只读窗口从 run
  `ac47a076-956d-469d-b5b7-4a9036cf7947` 完成时间
  `2026-07-28T10:28:51.828Z` 起算，但 Daemon 已于
  `2026-07-28T12:07:07.169Z` 重启为未锁定构建 `0.12.0+316eb41416db`，连续窗口
  因此中断。观察时还有 1 个 active Event，本轮 heartbeat 只记录 blocked，没有
  执行 canary。`2026-07-28T16:24:10.725Z` 再次观察时，Daemon 又变为
  `0.12.0+376bb1fbacc9`，并有 1 个 active Task worker，仍不满足精确构建和 idle
  门禁。`2026-07-28T20:23:36.277Z` 时运行面已 idle，但构建仍是
  `0.12.0+376bb1fbacc9`，所以精确构建门禁继续失败。需先将当前运行时改动形成
  可追溯提交、通过发布验证并冻结部署，再从新 T0 重新计算不可压缩的 24h。
  `2026-07-29T00:24:05.735Z` 再次确认仍是同一非目标构建且运行面 idle，没有
  新 T0，本轮继续只记录 blocked。`2026-07-29T04:23:41.301Z` 时 Daemon 又重启
  为 `0.12.0+27e9a5182037`；虽然 idle，但工作区仍有未提交运行时改动，依然不能
  建立新 T0。`2026-07-29T08:24:41.809Z` 时 Daemon 再次变为
  `0.12.0+9ea51be56887`，并有 2 个 active Event 与大范围未提交改动，本轮两项
  门禁均失败，继续只记录 blocked。旧 T0 的名义终验时间已于
  `2026-07-29T10:28:51.828Z` 到达，但这不弥补期间的构建中断；
  `2026-07-29T12:25:15.062Z` 时 Daemon 又变为 `0.12.0+d26fe770f81e`，并有
  1 个 active Event 和未提交运行时改动，M1.1 仍不能退出。
  `2026-07-29T16:24:44.066Z` 时 Daemon 又重启为 `0.12.0+bc01c6e46deb`；
  虽然 idle，但仍有大量未提交运行时/M1 清单改动，且仓库基线发生重写，不能建立
  可追溯新 T0。
- **凭证轮换需 owner/外部系统（M-1）**：2026-07-28 发现一枚 Multica access token 曾进入 Task objective、Schedule 和 Memory observation；原值不在本文件或诊断输出中。已扩展统一净化器，验证备份后净化 50 个数据库值，复扫 0 命中，原始记录仅保留在权限受限的已验证恢复备份。该凭证必须在 Multica 控制面吊销并重发；MimiAgent 不得代替 owner 点击授权或猜测新值。
- **M1 大象真实目标绑定需 owner/外部状态**：当前没有 owner 选定的精确会话、授权 revision，也没有唯一且非活动的已登录大象网页会话可用于 stable sid 绑定。允许完成 deterministic fixture、bounded read、Draft 和 fail-closed 代码；不得写入猜测目标、不得启用真实发送、不得伪造 72h soak。
- **macOS Life 恢复需 Calendar/Reminders TCC**：`macos-life` 属于 M4，当前保持 disabled 且配置完整。只有 owner 授权后，按 `docs/CONNECTORS.md` 的只读 probe 和恢复门禁重新启用；不得代点系统授权。
- **个人 QQ 恢复需真实 Adapter**：`personal-qq` 属于 M1，当前仅有未实现配置槽位，保持 disabled 且配置完整。实现并通过账号、稳定会话、bounded coverage、后台安全和 uncertain 测试前不得启用。
