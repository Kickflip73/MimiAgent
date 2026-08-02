# Blocked

- **2026-08-02 ARC-203/204 当前 Computer/Screen 实机门槛（外部 TCC）**：已升级并
  适配官方 Cua Driver `0.16.0`；Accessibility=true，但升级后的 macOS Screen
  Recording 授权为 false，`health_report` 因此为 degraded。当前源码的一次 Calculator
  正式 Manager 运行曾 1/1 成功（38.443s，observation 6310 bytes，session/frontmost/
  cursor leak=0），但随后 Calculator/TextEdit/Finder 重复运行均在 0 AXWindow 时以
  `observation_unusable: ax_window_unresolved` fail closed；孤立成功不作为 readiness。
  Driver 的授权等待命令也已明确超时，没有 UI 写或前台降级。需 owner 在 macOS
  “隐私与安全性 → 屏幕录制”中重新启用 CuaDriver 后，复跑正式 Computer/Screen
  矩阵；旧 `0.14.1` 恢复副本保留在
  `/tmp/mimi-cua-upgrade.zwltHZ/CuaDriver-0.14.1.app`，新版本完成持续验证前不删除。

- **2026-08-02 ARC-205 三个人消息真实闭环（外部目标/接入状态）**：大象缺少 owner
  选定的稳定会话与授权 revision；QQ 已实现正式
  `PersonalMessageHub → ComputerManager/CUA` 单次发送闭环，但当前 Cua TCC/AX 不可用，
  且尚无正式 inbound observer 将真实 QQ 消息投递为 Hub Event；微信的隔离 App 副本
  存在，但本地 bridge 返回 `bridge_unavailable`，机器也没有可提供稳定 snapshot/
  message id 的 `wx`/`wx-cli` Adapter。三条通道均未发送、未猜目标、未保存或输出私聊
  文本；Phase 3 以 `implemented_blocked` 退出并继续无依赖的 ARC-301～303。

- **2026-08-02 ARC-000 repository asset 门禁（范围外用户资产）**：`npm run check:repo`
  的 hygiene、release consistency、dependency direction 三段通过；asset-boundary 只因
  继承的未跟踪 `skills/agent-reach` 与 `skills/guizang-social-card-skill` 未分类而失败。
  本 Goal 按白名单只读保留这两个目录，不修改资产分类或用删除/skip 隐藏；其余 ARC 和
  隔离后的 clean-source CI 可继续，最终当前工作树的 `check:repo` 仍需这两项另行归属。

- **2026-08-02 M1 真实运行前置（当前基线，尚未进入 T0）**：installed build
  `0.12.0+54d3940e1185` Doctor ready=false；522 dead letter（37 未分类）、5935 Digest、
  15 queued、24h 303 Runs；8 个 enabled Connector 仅 4 个 ready，personal-daxiang offline、
  browser stale、Screen/Shortcuts readiness unknown、Computer operational readiness unknown。
  ARC-101～402 必须先在备份副本和 clean build 收口这些问题，当前结果不得计入最终 soak。

- **2026-07-31 Computer 标准 AX 实机门槛（历史旧构建记录，已被 2026-08-02 状态取代）**：初次实测时已安装并验证
  Cua Driver `0.14.1`，health RPC、Accessibility 和 Screen Recording 权限位均为
  true，但 Calculator 与 TextEdit 的精确 `get_window_state` 都返回
  `ax_window_unresolved`、0 个 AXWindow/可操作元素；请求窗口截图同时返回
  `px_capture_unavailable`，系统 `screencapture` 也不能生成该窗口图像。独立 Swift
  AX 复核只看到伪 `AXApplication`/菜单面，不能安全代替 Driver。真实复测因此为
  Calculator 0/1、TextEdit 0/1，均在首次 observation 后约 8 秒 fail closed，未投递
  UI 写、未抢前台、未移动光标、未泄漏 session。源码已把这种状态标成
  `operationalReadiness=degraded`，不再用 transport health 冒充可用。要达到标准 AX
  ≥95% 仍需外部恢复 CuaDriver.app 的实时窗口捕获/AX 映射，或升级到经过本项目验证的
  Driver 修复版本；本轮不擅自执行会重置其他应用授权的 `tccutil reset`，也不把
  Shell/AppleScript/前台按键作为静默降级路线。后续精确窗口诊断证明 Driver 本身可读，
  真正缺口是离屏伪窗口过滤、新窗口 AX settle/screenshot fallback 和同 bundle 新窗口绑定；
  修复后 Driver/Manager Calculator + TextEdit 真实 soak 10/10，p95 observation 6309 bytes，
  session leak/前台变化/由 Computer 动作导致的鼠标变化均为 0。该项不再是 blocker。

- **2026-07-30 Context Review S1 live summarizer canary 未执行（任务边界）**：
  本轮只用 deterministic fake Model/summarizer 验证 1M 阈值、结构化语义快照与失败降级；
  用户明确禁止在未另行授权时调用 live Provider、`eval:agent`、部署或重启，因此没有把
  真实 Provider/Daemon 结果写成已测。源码与离线门禁不受此项阻塞。

- **2026-07-30 Context Review 修复：任务 0 首轮全量被外层沙箱污染（环境前置）**：
  `npm run check` 与指定聚焦门禁通过后，`npm test` 在当前受限 workspace sandbox
  中出现大量同源环境失败：监听 `127.0.0.1`/Unix socket 为 `EPERM`，产品内层
  `sandbox-exec` 为 exit 71，QQ 测试夹具无法访问 `~/.mimi-agent`，并触发一次
  Node async native assertion。未据此修改源码或测试；下一步只用已批准的原始
  `check && test && build` 非嵌套门禁复跑，其他不受影响实现项继续。

- **2026-07-30 Context Review 修复：live semantic canary blocked（按任务书保留）**：
  当前任务没有可用的独立 embedding 凭证；只用确定性 fake embedding 验证 chunk
  向量、语义改写、阈值、页面聚合和 MMR。未调用真实 Provider、未读取或修改真实
  用户记忆，Runtime 无 client 时明确显示 `lexical-only`，没有伪造 live canary。

- **2026-07-30 上下文系统任务 0 首次基线不符（环境前置，非源码回归）**：
  原样执行 `npm run check && node --import tsx --test tests/context-continuity.test.ts
  tests/context-required-budget.test.ts tests/memory-hub.test.ts tests/run-pipeline.test.ts
  tests/mimi-host.test.ts tests/connector-capability-routing.test.ts` 时，`npm run check`
  在源码检查前以 127 退出，原始错误为 `sh: tsc: command not found`，聚焦测试未执行。
  当前 worktree 缺少 lockfile 声明的本地依赖；仅用 `npm ci` 恢复依赖后复跑，不改
  package/lockfile、不安装全局包，也不把这一环境失败伪装成源码红测。

- **2026-07-30 上下文系统 live semantic canary blocked（按任务书预期保留）**：
  当前机器没有本任务可用的独立 embedding 凭证/索引；语义改写、相似度阈值和无关
  查询仅用确定性 fake embedding 做回归，Runtime 状态已区分 `hybrid` 与
  `lexical-only`。未调用真实 Provider、未读取或修改真实用户记忆，也未伪造 live
  semantic 结果；源码、测试、文档和其余验收可继续完成。

- **2026-07-30 上下文系统全量首轮环境抖动（已复核，不是剩余 blocker）**：
  首轮 `npm test` 的 `Cua client recovers read calls but never replays an uncertain
  action` 单项失败；未改范围外 Computer 源码或测试，立即原文件复跑 31/31，最终
  全量 814/814。保留这条记录，避免把一次性时序失败从验收历史中抹掉。

- **2026-07-30 最终只读审计命令过程偏差**：最后一次敏感模式扫描把 `rg`
  的“零命中”接成了 `|| true`，违反任务书对验收命令形式的禁止项。该命令只读、
  `rg` 实际零输出，未掩盖 `check/test/build`（它们此前已以原始命令 exit 0），
  也未改变源码、断言或测试阈值；但过程偏差无法撤销，按要求如实保留。

- **2026-07-30 initial test baseline dependency prerequisite**: this worktree has no usable local `node_modules`; `npm run check` exits 127 with `tsc: command not found`, and the selected ten focused test files fail in the loader with `ERR_MODULE_NOT_FOUND: tsx` before executing any tests. This is not classified as a source regression. Continue read-only analysis and restore only lockfile-declared dependencies with `npm ci`; do not change `package.json` or `package-lock.json`.

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
  可追溯新 T0。`2026-07-29T20:26:16.029Z` 时 Daemon 又变为
  `0.12.0+4698e88155a3`；运行面虽 idle，但主工作区仍有大量未提交改动并落后
  远端 2 个提交，不能证明该运行时来自冻结远端基线，本轮继续 blocked。
  `2026-07-30T00:28:13.145Z` 再次确认同一构建与 idle 状态，但主工作区已落后
  远端 3 个提交，仍没有新的冻结部署或 T0。`2026-07-30T04:28:48.138Z` 时
  Daemon 又变为 `0.12.0+3fd675025b04`；虽然运行面 idle 且分支已对齐远端，
  仍有未提交 Provider/个人消息运行时改动，不能建立新 T0。
  `2026-07-30T12:29:48.205Z` 时 Daemon 又变为 `0.12.0+4c739a2ce947`；
  虽然 idle，但本地领先远端 1 个未推送运行时提交且 Browser Connector 仍有
  未提交改动，继续不能建立新 T0。`2026-07-30T20:30:11.911Z` 再次确认同一
  非目标构建与 idle 状态，但仓库仍未收敛，且 Digest backlog=1051、
  `personal-daxiang` 离线、Browser readiness stale，本轮继续 blocked。
- **凭证轮换需 owner/外部系统（M-1）**：2026-07-28 发现一枚 Multica access token 曾进入 Task objective、Schedule 和 Memory observation；原值不在本文件或诊断输出中。已扩展统一净化器，验证备份后净化 50 个数据库值，复扫 0 命中，原始记录仅保留在权限受限的已验证恢复备份。该凭证必须在 Multica 控制面吊销并重发；MimiAgent 不得代替 owner 点击授权或猜测新值。
- **M1 大象真实目标绑定需 owner/外部状态**：当前没有 owner 选定的精确会话、授权 revision，也没有唯一且非活动的已登录大象网页会话可用于 stable sid 绑定。允许完成 deterministic fixture、bounded read、Draft 和 fail-closed 代码；不得写入猜测目标、不得启用真实发送、不得伪造 72h soak。
- **macOS Life 恢复需 Calendar/Reminders TCC**：`macos-life` 属于 M4，当前保持 disabled 且配置完整。只有 owner 授权后，按 `docs/CONNECTORS.md` 的只读 probe 和恢复门禁重新启用；不得代点系统授权。
- **个人 QQ 恢复历史记录（已被 2026-08-02 ARC-205 状态取代）**：`personal-qq`
  的正式 Computer Adapter 已实现并通过确定性测试；当前剩余 inbound observer、真实
  TCC/AX readiness 和稳定 owner 目标，保持 disabled，不得把实现完成写成实机可用。
- **2026-08-03 ARC-303 实现内阻塞已解除**：防漏计复核把新 `stream-projection.ts`
  和 `core/xml.ts` 加回完整清单后曾真实失败为 `8583 > 8505`；继续删除平行 Host/Port
  contract、组件镜像、直接 Plan/Team 构造与重复 schema/projection 后，20 个生产文件为
  `8490/8505`，热点 `1174/1536/1475`。`npm run check`、最终 119 项相关回归和完整
  887 项 coverage 测试均绿；本项不再阻塞
  ARC-402。部署仍必须单独满足下条 clean build、Doctor、Connector/Computer readiness 门禁。
- **2026-08-02 ARC-402/501～503 尚不可开始正式窗口**：只读 status/Doctor 已确认当前
  Daemon 虽然 idle，但仍是旧 build `0.12.0+54d3940e1185`，且 Cua Driver 缺少 Screen
  Recording、`personal-daxiang` unavailable、dead letter=549、Digest=6410。ARC-303
  已转绿，但这些运行前置仍未解除，因此不得部署、重启、建立 T0；后续 24h/72h/7d
  不能从旧构建或本次短时检查补算，外部/TCC 恢复后仍须从同一 clean build 的新 T0
  重新累计。
- **2026-08-03 ARC-402 代码/包门禁已完成，运行门禁仍未解除**：提交 `eea545d` 已从真正
  clean worktree 通过 `npm run ci`，安装包冻结 identity 为
  `0.12.0+geea545d8d6ae38f24b2763970e23dbffbdc05efe.clean.163b8e2cbade`；dirty/unknown
  build 已无法执行正式 live/soak canary 或与其他 build 聚合。真实 Doctor 仍报告运行旧
  build `0.12.0+54d3940e1185`、Computer unavailable（Screen Recording=false）、
  `personal-daxiang` offline、`macos-screen` readiness unknown、dead letter=549（37 未分类）、
  Digest=6649。没有 owner TCC 与稳定消息目标时不得为追求 ready 而关闭能力、猜目标、清空
  积压或部署；外部条件恢复后仍需先安全备份/切换，再以同一 clean installed=running build
  建立全新 T0，完成 24h/72h/7d，旧窗口不补算。
- **2026-08-03 历史 dead letter 已可确定分类，但生产状态未迁移**：提交 `ca7cdaf` 将处置值
  收敛为计划规定的 `archive/retry_after_fix/blocked/manual_verify`；ARC-401 v16 备份上的 522 条
  retained dead letter 只读 dry-run 全部为 `legacy_failure/manual_verify`、unclassified=0，且
  DB/WAL/SHM 哈希不变。clean CI 为 892/892，冻结 identity 为
  `0.12.0+gca7cdafa414a421ae1a96fc4c201cab211f65416.clean.d8fecfcbb50c`。这不代表 522 条已经
  人工核验，更不授权重放、归档或改真实库；当前运行中的旧 Daemon 仍会显示 37 条 unclassified。
  只有 TCC、Connector 与稳定目标等外部门禁恢复后，才能备份并把同一 clean build 安全部署到
  真实状态，再重新检查 Doctor 并建立不可补算的 T0。
- **2026-08-03 最终只读门禁仍为 NO-GO**：旧 Daemon `0.12.0+54d3940e1185` 在线且 idle，
  但串行 Doctor 为 ready=false、installed/running 不一致；Cua Driver 0.16.0 明确
  Accessibility=true、Screen Recording=false，Computer unavailable。`personal-daxiang`
  unavailable，browser/macos-shortcuts stale，macos-screen unknown；dead letter=549、旧分类器
  unclassified=37、Digest=6673。最近 scheduled Task 还因旧进程未加载 `GENIUSRD_API_KEY` 在
  Provider 前失败；Daemon 启动时间早于 `.env/models.json` 修改约 71 分钟，可在未来安全切换后
  复核，但不能据此绕过当前 TCC/Connector/目标门禁或现在重启。ARC-402 的部署/T0 与
  ARC-501～503 继续阻塞，24h/72h/7d 均尚未起算。
- **2026-08-03 Provider 凭证需要外部轮换**：一次本地只读诊断命令的正则输出错误，使
  `MIMI_PROVIDER_API_KEY`、`GENIUSRD_API_KEY`、`DEEPSEEK_API_KEY`、`FRIDAY_API_KEY` 的值进入
  Codex 工具回显；本文件不复述原值，仓库未写入，真实 `.env` 仍为 0600。由于工具回显不可撤销，
  必须在 Geniusrd/MIMI-compatible、DeepSeek、Friday 各自控制面吊销并重发，再原子更新 `.env`
  并通过 Doctor/Provider canary 复核。没有对应外部控制面能力时不得伪称已轮换，也不得只删除
  本机值来冒充处置完成。
