# CUA 单次点击重复投递修复与实测

2026-11-05。此记录补充 P0 实施记录；使用本机真实 macOS 窗口和真实 MimiAgent CLI → Daemon → 配置中的模型 → Computer 工具链，没有用脚本动作代替模型调用。

## 根因与修复位置

原安装的 CUA Driver 为 0.16.0。同一个事件先经 SkyLight `SLEventPostToPid` 投递，又无条件调用 `CGEvent.post_to_pid`，源码称之为 “belt+suspenders”。目标 NSView 收到两个具有相同 eventNumber/timestamp 的 mouseDown，随后收到两个 mouseUp。NSButton 会合并部分事件，因此只数按钮回调会漏报。

独立控制组直接向 NSApplication 发送一对 down/up，只计数一次；原 Driver 单次调用计数两次。旧版真实 MimiAgent 同样只有一次 `computer_act(click)`，目标计数却增加两次，排除了模型重复调用和探针重复计数。

Driver 改动保存在独立工作树 `/Users/example/Project/cua-click-fix`，分支 `codex/cua-single-mouse-delivery`，基于精确版本 `cua-driver-rs-v0.16.0`（`4310a1a5e`）。点击修复位于 `libs/cua-driver/rust/crates/platform-macos/src/input/mouse.rs`：

- Chromium 点击、通用鼠标事件和滚轮事件统一选择单一投递路径。
- SkyLight 入口存在时只调用它；入口不存在时才走公开 API。
- “尝试投递”不代表成功确认，不能因缺少确认再发送一遍。没有添加自动重放。
- 未改 Windows/Linux 实现，未替换 `/Applications/CuaDriver.app`。

接入主实例时另发现 `tools/health_report.rs` 只认正式版 bundle ID，而 `tools/check_permissions.rs` 已支持本地版。健康检查现复用权限模块的应用路径映射；本地 ID 必须匹配本地 app 路径，空 ID、错误 ID、散装本地二进制仍失败。新增边界测试先在旧逻辑失败，修复后健康检查 7 项、权限模块 12 项测试通过。没有放宽实际 TCC 检查。

本地构建安装到 `/Users/example/Applications/CuaDriverLocal.app`，独立 bundle ID 为 `com.trycua.driver.local`，使用自己的 daemon namespace。临时签名在重编译后变化，需要通过系统设置重新添加同一应用以刷新旧签名授权；没有修改 TCC 数据库或绕过权限门禁。最终 Driver 自查辅助功能、屏幕录制均为 true，health_report 为 `ok`。最终二进制 SHA-256：`d8ba7aa97190fb222c107706aed04ebae0fe189a42a9fcde420fd4dbe7a18adc`。

## 回归探针

- `tests/fixtures/computer-grounding-probe.swift`：记录 NSApplication 入口与目标视图事件；同时提供原生 NSButton、WKWebView DOM 计数器。原生控制组用 NSEvent，Web 控制组用 DOM dispatchEvent 校准计数器；后续被测点击全部由 Driver 发出。
- `scripts/run-computer-grounding-probe.ts`：绑定自建进程、精确窗口标题和窗口 ID，点击前检查截图宽高比例；使用原始图片像素坐标，分别测试移动窗口前后。缺截图、超时、重复事件均失败退出；异常也写入失败报告。
- `scripts/lib/computer-probe-agent.ts`：启动隔离数据目录的真实 MimiAgent daemon，使用本机已配置的模型。提示只说明找蓝色方块并单击一次，不提供坐标；最终用窗口进程的独立计数及 transcript 中的真实调用次数验收，退出时清理自己的 daemon。

Driver 的离屏激活准备事件仍可出现在 NSApplication 入口日志中。以下 down/up 统计指目标控件收到的事件，准备事件不会计入目标命中。

## 已执行的结果

| 项目 | 原版 | 修复版 |
| --- | --- | --- |
| 原生目标单次点击 | 每次 2 down / 2 up | 连续 10 次共 10 down / 10 up |
| 移动窗口、2 倍截图 | 命中，但事件重复 | 上述 10 次中前后各 5 次，均命中且不重复 |
| 原生按钮 | 3 次各 1 回调，无法暴露重复事件 | 3 次各 1 回调 |
| WKWebView 目标 | 未做同条件旧版比较 | 连续 10 次共 10 down / 10 up，按钮 3 次各 1 回调 |
| 真实 MimiAgent，原生窗口 | 1 次工具点击 → 2 次目标命中，失败；37,716 ms | 1 次工具点击 → 1 次目标命中，通过；31,618 ms |
| 真实 MimiAgent，WKWebView | 未运行 | 1 次工具点击 → 1 次目标命中，通过；33,999 ms |

上述首次点击修复回归后，补入本地 bundle 健康检查修复并重新安装最终二进制，再次执行：原生 10/10、WebView 10/10、两类按钮各 3/3 通过；隔离的真实 MimiAgent 原生点击再次通过，耗时 44,769 ms。随后使用日常主实例（PID 38516）的真实 MimiChatClient → Daemon → 模型链路，在新建专用 Session 中实际执行一次点击：**42,281 ms，目标 1 down / 1 up，按钮计数保持 0，验收通过**。主实例进程环境确认指向修复版，状态返回 `ready:true`、`operationalReadiness:ready`、`consecutiveFailures:0`。

主实例验收使用 `/tmp/mimi-main-click-smoke.py` 创建自己的测试窗口、经正常 ChatClient 提交新 Session、读取权威历史及独立窗口计数；没有替换真实模型动作。前两次主实例测试准备因指定 Session 尚不存在而失败，未发送点击；改用正式 ChatClient 的新 Session 提交流程后完成验收。

首次两轮真实模型修复版测试都先观察截图、自行定位，再只执行一次点击；独立计数从 3 增至 4，按钮计数保持 3。最终二进制的隔离测试从 11 增至 12；主实例测试从 0 增至 1。耗时是单次样本，不能据此计算速度提升百分比或 p95。

其他验证：Driver `cargo build -p cua-driver --locked`、`cargo fmt --all -- --check` 通过；MimiAgent `npm run build`、`npm run check` 通过；Computer 与 verification 的 85 个聚焦测试全部通过。P0 首轮全量 1,279 个测试的结果仍见原实施记录，本轮没有把它冒充为重新运行的全量结果。

## 保留的失败与限制

- 首轮修复版连续测试在 7 次正确点击后，第 8 次未得到有效截图，测试失败退出且没有继续点击。后续完整 10 次通过，但首次没有保存 Driver 的截图错误详情，根因仍未确定；现在探针会保留该错误。这项稳定性问题不能宣称已修复。
- Web 探针初版 NSEvent 控制组无法送达 DOM；改成 DOM 计数校准。随后发现只按 PID 取第一个窗口会选到同进程辅助窗口，已改为精确窗口绑定，并增加截图比例断言。这些失败没有计入成功样本。
- 未覆盖独立 Chromium/Catalyst 应用、多显示器、公开 API fallback、右键/拖动/滚轮以及长时间压力测试。共享投递函数涉及这些路径，尚不能据此宣称全平台或全部交互通过。
- 原始报告位于本机 `/tmp/mimi-click-agent-before.json`、`/tmp/mimi-click-agent-after.json`、`/tmp/mimi-click-after-native.json`、`/tmp/mimi-click-after-web.json`、`/tmp/mimi-click-agent-after-web.json`。不把真实模型 transcript 或本机配置提交到仓库。
- 最终安装版本复验报告：`/tmp/mimi-click-final-native-agent.json`、`/tmp/mimi-click-final-web.json`、`/tmp/mimi-click-main-instance.json`。

## 复验与启用

```bash
MIMI_CUA_DRIVER_COMMAND=/Users/example/Applications/CuaDriverLocal.app/Contents/MacOS/cua-driver-local \
MIMI_PROBE_ITERATIONS=10 MIMI_PROBE_REPORT=/tmp/mimi-click-native.json \
node --import tsx scripts/run-computer-grounding-probe.ts
```

加 `MIMI_PROBE_SURFACE=web` 测 WebView；加 `MIMI_PROBE_AGENT=1` 会调用真实配置模型并产生费用，只应在明确授权后执行。加 `MIMI_PROBE_KEEP=1` 保留临时诊断材料。

已在本机 `~/.mimi-agent/.env` 配置 `MIMI_CUA_DRIVER_COMMAND` 指向修复版，原配置有 0600 权限的备份 `.env.before-cua-single-click-20261105-165516`。运行中的主 daemon 曾因活动事件拒绝正常重启；等待安全关闭后完成切换，没有强制中断活动任务。最终主实例已重新启动，并通过上述真实观察与点击验收。现有未提交改动保留，未执行 Git commit。
