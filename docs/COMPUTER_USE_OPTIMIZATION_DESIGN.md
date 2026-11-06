# Computer Use 能力优化设计

状态：设计提案，尚未实现。日期：2026-11-05。

目标：提升电脑操作的端到端成功率、目标定位准确度、速度和故障恢复可靠性。以“打开网易云播放每日推荐”Badcase 为切入点，解决通用桌面操作问题，不把音乐业务加入内置工具。

## 1. 决策摘要

保留 `computer_observe` / `computer_act`、`ComputerManager`、CUA Backend、ExecutionLedger 和唯一主 Agent。优先补齐明确的目标/坐标契约、动作结果验证、无进展停止以及统一的桌面执行入口。借鉴 Codex 的持久对象、图像反馈和短组操作，不在第一阶段引入任意 JavaScript 执行器或第二个电脑 Agent。

实施顺序：

1. P0-A：修正评测判定，记录真实基线与分阶段耗时。
2. P0-B：统一坐标和目标绑定；动作投递与结果验证分离。
3. P0-C：封住桌面动作的跨入口换路，修正冲突指令；加入无进展和观察预算保护。
4. P1：结构化视觉定位、完整观察回读、自适应验证、应用发现优化。
5. P2：有界动作组；有证据表明传输是瓶颈后，优化 Driver 连接。

每一步都设独立验收门槛；P2 不作为完成 P0/P1 的前提。所有性能和成功率数值是待验证目标，不是已有结果。

## 2. 已核对的现状与证据边界

本设计基于当前工作区源码；工作区存在其他未提交修改，不假定其等于 Badcase 运行版本。日志没有完整原始图片/Driver 回包，不能断言历史每次点击的真实落点。41 次调用、763 秒总耗时和约 169 秒工具区间来自粘贴日志的秒级时间戳；余下 594 秒包含模型、调度与其他调用间开销，不等同于纯模型计算时间。

| 当前模块 | 已有能力 / 具体问题 | 设计响应 |
| --- | --- | --- |
| [tools.ts](../src/extensions/computer/tools.ts) | 双工具、动作后回读已存在；`x/y` 缺少单位说明；`ComputerPerception` 返回 `unknown`；多帧固定等待 250ms | 升级契约，复用入口，不再新增同类工具 |
| [cua-driver-client.ts](../src/extensions/computer/cua-driver-client.ts) | `dimensions` 优先 PNG 大小，否则读取 Driver size；坐标原样转发；每次 `callOnce` 使用 CLI 子进程 | 拆分坐标空间，验证实际 Driver 协议；后期再测传输优化 |
| [manager.ts](../src/extensions/computer/manager.ts) | 已有 Run Session、窗口身份检查、动作锁、30s Observation TTL、动作/截图额度 | 保留安全约束，增加绑定版本、结果验证与进展状态 |
| [media-understanding.ts](../src/runtime/media-understanding.ts) | 通用文本视觉理解、45s 截止、按图像和问题缓存；没有专用定位 schema | 增加独立的无工具 Computer 感知适配，不把自然语言当动作参数 |
| [run-pipeline.ts](../src/runtime/pipeline/run-pipeline.ts) | Computer 感知复用普通媒体路由；主会话模型绑定不变 | 注入专用感知接口，保持 provider 能力路由 |
| [model.ts](../src/runtime/model.ts) | 有 Computer 历史图片投影逻辑 | 核验最新图片是否在首次消费前被删；按协议单元保留必要视图 |
| [connector-action-tool.ts](../src/daemon/connector-action-tool.ts) | 按 `browser` / `desktop` 等 ID 隐藏部分私有 Connector | 不依赖 ID 名称作为唯一边界；对 macOS Desktop 等入口做发现与调用双重约束 |
| [tool-ledger.ts](../src/runtime/tool-ledger.ts) | 已有 uncertain fence、SDK 重送保护及 occurrence | 保留并强化稳定目标身份；不要用新截图绕过 uncertain |
| [Computer Skill](../skills/computer-use/SKILL.md) | 写着默认后台、每动作单独观察，又含直接置前建议 | 与当前授权、动作自带回读、未来短组契约统一 |
| [Agent E2E](../scripts/run-mimi-computer-e2e.ts) | 输入给定精确工具步骤；在输入/输出合并文本搜索预期字符串 | 保留为协议冒烟，增加独立终态判定和只给任务目标的评测 |

特别说明：Agent E2E 的预期字符串也出现在 prompt 中，因此文本包含判断存在假阳性风险。当前 ComputerManager 已保留 Driver Session，本方案不是重新建设持久会话；优化重点是把这份状态以清晰契约提供给模型。

参考来源是公开设计与当前可见接口，不声称复刻 Codex 内部实现：

- [Codex Computer Use](https://developers.openai.com/codex/computer-use)：应用范围、权限和使用边界。
- [Computer Use 集成方式](https://developers.openai.com/api/docs/guides/tools-computer-use#choose-an-integration-path)：代码执行与结构化动作两种接口。
- [保存状态与返回观察](https://developers.openai.com/api/docs/guides/tools-computer-use#preserve-state-and-return-observations)：持续环境、短组动作后的图像反馈、坐标转换。

## 3. 架构与范围

```text
唯一主 Agent：理解目标、选下一步、拥有最终回答
   │ computer_observe / computer_act
   ▼
extensions/computer
   tools：Zod 参数与输出、模型可见引用
   manager：Run ownership、目标绑定、预算、权限、锁
   grounding：坐标变换与定位结果验证（新增，纯函数）
   verification：证据判定与有界观察（新增）
   cua-driver-client：已校准的 Driver 协议适配
   │
   ▼
现有 CUA Driver

runtime：注入无工具视觉能力、路由、取消、Trace、账本包装
core：复用 ActionIntent / ExecutionLedger / Trace / Goal 语义
daemon：Connector broker 做桌面入口约束，接入同一权限控制
```

不新增工作流数据库，不自动为简单操作创建 Goal，不修改核心依赖方向。视图、视觉目标、无进展计数属于 Run 内临时状态；持久证据继续使用现有 Trace、账本及受保护 artifact store。旧 Run 的引用不可在新 Run 执行；进程恢复后重新观察，不恢复鼠标动作队列。

首期以 macOS 现有 Backend 为范围。浏览器网页继续优先现有 Browser/DOM 能力；不在本方案内重新实现浏览器。低频应用业务知识放在 Skill，优先使用已授权且可靠的结构化接口；不盲试 URL scheme 或未验证的快捷键。

## 4. P0-B：坐标与目标契约

### 4.1 先校准 Driver，再固定对模型的协议

现有文档写“窗口局部坐标”，但无法仅凭 PNG 尺寸确认 Driver 接收的是窗口逻辑点还是缩放后的截图像素。实施第一项必须是 Driver contract probe：在可控测试窗口布置已知位置的按钮，通过后台 click 和截图验证真正命中；覆盖移动窗口、1x/2x、非整数截图缩放、外接屏、裁剪。记录 Driver 版本和平台。

探针仅在测试应用执行，不点击用户实际业务窗口。如果当前 Driver 未暴露足够的裁剪/缩放元数据，先补适配或上游支持；不能凭长宽比猜边框、阴影或标题栏偏移。无法证明转换时返回 `coordinate_mapping_unavailable`，允许 AX 操作但拒绝像素写动作。

对模型统一承诺：视觉点坐标始终属于它看到的那张图片，原点左上，单位像素。Host 内部转换到 Driver 原生空间。AX frame 明确标记自己的空间，不能与截图坐标混用。

新增 `grounding.ts` 纯函数处理 crop/scale/translation；窗口屏幕偏移只在 Driver 需要屏幕坐标时加入。根据已观测元数据建立变换，禁止两处重复转换。单元测试要求映射往返误差不超过 1 个目标逻辑点；实机要求实际命中标注控件。

### 4.2 用不透明引用绑定证据

下列字段为拟议协议，不是现有接口：

```ts
type LocatedTarget = {
  targetRef: string;          // Host 生成，只在当前 Run/视图有效
  label: string;
  source: 'ax' | 'vision';
  box?: { x: number; y: number; width: number; height: number };
};

type ComputerView = {
  viewRef: string;            // 公共证据引用，不是 PID/windowId/Observation UUID
  app: { id: string; name: string };
  capturedAt: string;
  coordinateSpace: 'image_px';
  imageSize?: { width: number; height: number };
  targets: LocatedTarget[];
  evidenceQuality: 'semantic' | 'visual' | 'insufficient';
  budget: { screenshotsRemaining: number; verificationReserved: number };
};
```

工具仍只有两个。`computer_observe` 可增加有界 `targets` 查询、`region` 和 `sampleIntervalMs`；返回结果一次包含页面判断、目标和阻塞提示。`computer_act` 的定位使用互斥 union：

- `{ targetRef }`：AX 或辅助视觉定位得到的 Host 引用。
- `{ viewRef, point: { x, y } }`：原生多模态主模型从已提供截图确定点位。
- 内部 Host adapter 继续可用原有 elementIndex，但模型侧迁移到 targetRef。

内部 ViewRecord 保存 Session/Run、精确窗口、图像哈希、布局版本、裁剪/变换、捕获时间和目标框。模型不能指定这些内部字段。引用解析校验 ownership、授权、窗口身份、布局状态与 TTL；不能把新 AX 观察绑定给旧截图坐标。

保留 TTL 作为上界；动作前检查窗口几何和目标证据。变化时返回 fresh observation / `target_stale`，不自动点击。对于不可观察的瞬时界面竞态，仍以动作后验证兜底，不宣称消除了所有 TOCTOU 风险。

### 4.3 兼容性

内部 schema 与 Backend 分阶段迁移；旧持久 transcript 只读兼容，不重放。旧裸坐标调用无法证明空间时，明确拒绝并指导重新观察；不能悄悄改解释方式。保留 `ok` 给旧展示层，但定义为调用/投递层状态，不是业务完成。新版工具输出增加 `contractVersion`。

`viewRef/targetRef` 是对现有“隐藏内部句柄”的小幅扩展：只暴露不可伪造、不可跨 Run 使用的证据引用，原生 PID/windowId/Observation id 仍不暴露。实施时同步更新 ARCHITECTURE 与 COMPUTER_USE，而非让实现暗中偏离文档。

## 5. P0-B/P1：执行与验证分开

```ts
type ComputerResult = {
  delivery: 'applied' | 'not_applied' | 'unknown';
  verification: {
    status: 'passed' | 'failed' | 'unknown' | 'not_requested';
    evidenceRefs: string[];
    method?: 'ax' | 'visual' | 'structured_adapter';
    reason?: string;
  };
  state?: ComputerView;
};
```

`applied` 只代表动作投递层面，默认不代表 UI 改变；`passed` 只覆盖本次指定条件，不能替代整个任务完成。观察失败时保留已投递事实，返回 `verification=unknown`，禁止因此重发动作。

`verification.ts` 接受少量通用条件：目标存在/消失、文本/值等于预期、选择或开关状态、指定区域值随时间变化。AX/结构化条件使用确定性比较；视觉条件用绑定图片的结构化判断，并标记方法和不确定项。不能把整张截图 hash 变化当业务成功，也不能把模型自报 confidence 当保证。

等待基于截止时间和可观察条件；循环只做读。静态控件就绪后立即结束；播放器秒数推进建议在 1.5–2 秒后再次取样，按真实时间戳比较，若有缓冲则在剩余预算内等待。两帧相同只能说明“本窗口未观察到变化”。

动作后的回读沿用本轮有效观察模式：若该窗口 AX 没有任务相关控件，返回视觉观察，而不是把一个 AXWindow 称为完整 fresh state。模式选择由本次证据决定，不把“Electron 都不可读”写成永久事实。

对于显式 Goal，`completion-coordinator.ts` 只将匹配条件且 `verification=passed` 的新 Computer 回执用于业务验收；旧回执没有 verification 时不能自动升级为 UI 成功。普通短任务不新建 Completion Contract，主 Agent 根据结构化结果回答；因此仍需评测错误成功报告率，不能仅靠工具声称有硬保证。

## 6. P0-C：恢复、预算和一致权限

### 6.1 失败分类

| 情况 | 允许的恢复 | 不允许的行为 |
| --- | --- | --- |
| 定位歧义、过期、坐标映射缺失，尚未投递 | 局部重观测/重新定位一次，或用有效 AX 目标 | 刷新 AX 后沿用旧像素 |
| 明确 `not_applied` | 核实前置条件后，由模型发起一个新的有依据动作 | 无证据自动重试 |
| `applied` 但预期状态不成立 | 只读诊断弹窗、加载、错误和真实状态；有新证据才调整策略 | 原样反复点击、用 toggle 试探状态 |
| `unknown` / 进程崩溃 / 回包丢失 | 只读检查并报告；遵循现有 uncertain fence | 换工具、窗口、截图或 batch 重放 |
| 权限不足/用户正在使用目标 | 按当前授权返回阻塞；已有授权可正常使用 | 激活别的应用来规避后台限制 |
| 预算不足且视觉是唯一证据 | 用预留额度完成核对，或结束并报告未验证 | 失去观察后继续坐标写动作 |

### 6.2 无进展检测

RunState 增加小型 progress record：稳定窗口身份、目标语义、动作类别、任务相关状态摘要、失败类别、连续计数。无进展不是“整屏像素相同”：播放器动画可能变化而目标操作没有进展。

同一目的动作在无新证据的状态下，第一次未验证后返回可执行诊断建议；若再发起相同动作且仍无新证据，Host 拒绝投递。合法重复滚动/输入不按文本相同直接封禁，应结合可验证进展；改变数个像素或更换工具名不能重置计数。策略切换最多允许一次有新证据的替代路线，权限拒绝和 uncertain 不属于可切换路线。

简单交互默认提议：首次 Computer 操作至完成/阻塞的 90s 预算，单次视觉定位 15s 内有界结束，保持 12 张截图上限且预留 2 张用于验收。阈值需基线校准；长任务由可信 Run 配置调整，不由页面文本或模型任意扩大。截图多帧预先检查额度，避免采完第一帧才发现第二帧无额度。预留额度不能被普通定位消费；不足时先拒绝新的视觉依赖动作。

视觉超时只是观察失败，不是动作失败。超时、取消要向下传至模型/Driver，迟到结果不能写当前 Run。用户停止后不再派发写动作；已越过提交点的动作按真实回执或 unknown 处理。

### 6.3 桌面入口统一

第一阶段采用最小方案：模型可见的 GUI 写操作归 Computer；现有 Browser/DOM、专用 Connector 业务事务保留自己的 route owner。对 `activate_app`、键盘/菜单注入等通用桌面写操作，在能力发现和调用时同时拒绝旁路，不只按 Connector ID 为 `desktop` 隐藏。保留经授权的只读窗口查询与非 GUI 业务能力。

分类来自 Host 认可的 Connector 能力声明和映射；Connector 声明只能收窄权限，不能授予权限。覆盖 macos-desktop、别名、gateway 与直接 invocation；如必要 GUI 后端操作只能从统一 Computer 控制路径调用。暂不实现两套 GUI 执行器之间的自由切换。

现有 `computerAction` 的目标证据引用含 observationId。升级时在提交前将公共目标解析为稳定的宿主目标身份，再生成 ActionIntent：证据版本与稳定业务目标分开。截图更新不能解除 uncertain；合法新动作由现有 occurrence 区分；SDK 重送/恢复仍对应原 occurrence。不另建第二本账。

工具封装的 preflight 和 execute 应消费同一份 resolved action，避免两次 bindLatestAction 绑定到不同视图。保留跨进程动作锁；增加覆盖“派发—关键回读”的有界控制区间。失锁/超时后不得盲重试，旧 worker 的迟到动作必须在提交前被 ownership/fencing 检查拒绝。不给模型长期独占桌面的无限租约。

## 7. P1：视觉、上下文与发现

新增 `src/runtime/computer-perception.ts`，作为无工具适配器，由 runtime 注入 extensions，不反向依赖 runtime：

- 原生 imageInput 主模型直接消费截图和尺寸/时间元数据，不重复调用辅助视觉模型。
- 文本主模型经现有 ModelGateway/WorkUnitModelResolver 选择支持图片的无工具模型，返回 Zod 校验的目标框、状态事实、阻塞项和无法判断项。
- 统一 source/provenance；图片中的文字属于待观察数据，不是权限或指令。
- 坐标必须有限、在指定图片内、目标框非空；校验通过只证明格式有效，不证明定位正确。
- 小目标支持一次局部高清定位，Host 维护 crop 变换；无法唯一确定则不生成可执行目标。
- 一次观察联合回答页面/目标/阻塞/状态问题，避免同图反复不同问题。
- 缓存只复用完全一致像素上的纯感知结果，key 包含模型、prompt/schema 版本、任务查询和图像信息；每次重新签发 Run/视图引用。动态状态判断必须包含真实帧时间，不跨时间复用“正在播放”等结论。首期 Computer 感知采用 Run 内缓存，避免扩散通用媒体持久缓存中的私人 UI 内容。

`model.ts` 的历史投影保留当前最新且需要消费的图片及必要前一帧，其他图片可转成带 evidenceRef 的摘要；不得在首次消费前删图，不拆 function_call/result 单元，不把辅助感知或临时状态写成假 user/assistant transcript。需要回读时使用现有受控 artifact 机制。

`listApps` 增加可检索、可分页的返回契约；优先精确 bundleId/path/display name，读取系统安装信息中的本地化名称。名称歧义返回候选，不让模型靠猜 bundleId 或全盘 Shell 搜索。缓存目录可跨短调用复用，启动失败或目录变更后失效；不缓存桌面焦点等瞬时状态。

## 8. P2：有界动作组和传输优化

保留两个工具，未来 `computer_act` 可接受 1–4 个已绑定动作和共同的最终验证条件。适用同一稳定表单的聚焦/输入等已知操作；页面跳转、对话框出现、需要新定位、提交/发送等外部事务必须形成边界。内部每步仍检查授权和状态，遇到未知状态立刻停止余下动作。

动作组不是一个可整组重试的黑盒：由 Host 分配 sequenceId 和 step index，每个副作用步骤复用账本 claim；返回逐步 delivery/evidence，支持部分完成。重复 SDK call 不再次执行；崩溃后未执行后缀也不自动续跑，重新观察并由 owner/主流程按现有恢复规则处理。完成此账本整合前，不向模型开放 actions 数组。

不引入任意 JS/Node REPL：当前安全与账本只覆盖受控原子动作，任意代码会扩大控制面并掩盖部分副作用。只有受控动作组无法满足经评测证实的需求时，再独立设计 sandbox API。

测量 `callOnce` 的 spawn、Driver 请求与截图耗时。如果 CLI spawn 确为显著成本，再评估已安装 CUA SDK 的持久连接；遵循现有 lifecycle 与跨进程锁，native driver 不能每个 Session 启动一份独立桌面控制器。保持 Backend 接口与不重试写动作契约，做 CLI/持久连接的逐项一致性测试后再切默认。仅靠替换传输不能解决 Badcase 的主要调用间耗时。

## 9. 模块变更清单与交付包

表内新增文件是拟议目标；不是本次已经创建的代码。

| 交付包 / 优先级 | 修改模块 | 验收门槛 |
| --- | --- | --- |
| A / P0 | `scripts/run-mimi-computer-e2e.ts`、`scripts/run-computer-e2e.ts`；`tools.ts`/`manager.ts`/`cua-driver-client.ts` 注入计时回调，`runtime/hooks.ts` 接入现有 Trace | 测试故意只回显输入时必须失败；有独立终态；能分开 model/vision/driver/wait 时间 |
| B / P0 | `extensions/computer/types.ts`、`tools.ts`、`manager.ts`、`cua-driver-client.ts`；新增 `grounding.ts` | Driver contract probe 通过；比例/原点/裁剪/跨 Run 错误不能投递 |
| C / P0 | 新增 `extensions/computer/verification.ts`；`tools.ts`、`manager.ts`、`runtime/tool-ledger.ts`、`runtime/completion-coordinator.ts` | applied/unknown 与业务验收分离；迟到回执、崩溃不重复执行；Goal 不接受无业务验证回执 |
| D / P0 | `daemon/connector-action-tool.ts`、必要的 `daemon/connectors.ts` Host guard；`runtime/pipeline/capability-registry.ts`、`tool-set-builder.ts`、`capability-resolver.ts`；Computer progress guard | macos-desktop/别名/gateway 无旁路；无进展拒绝；Plan/Safe/SubAgent/Team/非 owner 权限不扩大 |
| E / P1 | 新增 `runtime/computer-perception.ts`；`run-pipeline.ts`、`mimi-agent.ts`、`model.ts`，复用 `model-gateway.ts` / `work-unit-model-resolver.ts` | 原生图像与文本+视觉两路都通过；缓存不复用旧状态；视觉失效停止坐标写动作 |
| F / P1 | `manager.ts`/`cua-driver-client.ts` 应用发现、AX fallback；`config.ts`、`.env.example`、说明文件 | 中文名可唯一解析，歧义可读；预算配置正确，前后台与模式约束一致 |
| G / P2 | `tools.ts`、`manager.ts`、`runtime/tool-ledger.ts`；仅必要时扩展 `core/tool-metadata.ts` / `core/execution-ledger.ts` 的兼容元数据 | 部分执行/重送/恢复测试全过后才开放 batch；Core 不依赖 Computer |
| H / P2 | `cua-driver-client.ts`、`cua-driver-lifecycle.ts`、`runtime/components.ts` | 新旧 transport 行为一致、有实测性能收益、无 Session/进程泄漏 |

每包同步相关 `tests/computer.test.ts`，可按契约拆为新 `tests/computer-grounding.test.ts`、`tests/computer-verification.test.ts`、`tests/computer-progress.test.ts`。D 扩展现有 Connector 路由/边界测试；E 扩展模型路由/图片历史测试；G 扩展 ledger 集成测试。

实施文档同步范围：`docs/COMPUTER_USE.md`、`docs/ARCHITECTURE.md` 及英文对应部分、`src/runtime/instructions.ts`、`skills/computer-use/SKILL.md`、必要的 `MIMI.md`。按实际新增配置同步 `.env.example`/配置文档，发布行为形成后更新 CHANGELOG。本提案不修改这些运行契约。

## 10. 验证设计：四类指标与独立判定

### 10.1 指标定义

| 维度 | 指标及分母 | 第一阶段目标（受控简单任务） |
| --- | --- | --- |
| 成功率 | 独立终态判定成功数 / 所有已开始的有效试验；timeout/unknown/中途环境问题均记结果，另给条件化统计 | 点估计 ≥95%，Wilson 95% 下界 ≥90% |
| 准确度 | 首次落点位于正确可交互目标且实际命中的次数 / 首次定位动作；另报目标查全率、错误目标率、拒绝率 | 首次命中 ≥98%；不得靠大量拒绝虚增命中率 |
| 速度 | 从首次 Computer 请求到已验证成功/失败/超时的端到端时长；另报完整用户请求延迟 | P50 ≤30s，P95 ≤90s；模型往返中位数较基线下降 ≥30% |
| 可靠性 | 已完成报告但独立判定失败的次数 / 完成报告数；每次试验的重复副作用、越权、焦点干扰、资源泄漏 | 测试中观察到 0 次错误成功、0 次重复副作用/越权/泄漏；报告样本量与置信上界 |

通过必须同时满足成功率与速度，快速失败不能充当提速。报告全部试验的终态耗时和成功子集的 time-to-success；超时样本在截止时记超时，不伪装为 90s 内成功。桌面准备/授权/登录开销单独列出，同时提供含这些开销的用户视角总时长。

另报：平均/P95 视觉耗时、模型耗时、Driver 读/写耗时、无进展调用比例、stale 拒绝率、截图张数、恢复率、每次成功成本、取消后新写派发数。各耗时 span 标记父子关系，避免辅助视觉计入 tool 时间后又重复累加。

零观测错误不代表零风险：例如 200 次中未观察到错误，单侧 95% 上界近似仍为 1.5%。按 provider/模型、AX/视觉、前后台和场景分别报告，不把不同能力路径混为一个通过率。

### 10.2 测试层级

**L0：确定性单元/协议测试，无真实账号、网络、API Key。**

- 几何变换：1x/2x/1.48x、负屏幕原点、窗口移动、裁剪、标题栏偏移元数据、非法坐标；同样数值在错误空间必须拒绝。
- 引用隔离：跨 Run、跨 Session、窗口替换、旧截图+新 AX、布局变化、过期目标。
- 状态机：not_applied/applied/unknown、动作成功后观察失败、取消、未投递超时、投递后断连、Driver 崩溃。
- 无进展、预算预留、多帧原子预检、时间间隔、辅助视觉超时/非法 JSON/越界框。
- uncertain 后换 targetRef/截图/入口不重放；合法重复按键按 occurrence 执行；SDK 同 call 重送只一次。
- 多 Session 同桌面争用、前台抢占、迟到 worker、受保护应用、模式/来源/allowlist。
- 测试使用 fake clock/可观察 barrier，不用不确定的 sleep 等待并发结果。

**L1：可重置的测试 UI 与已标注图像。**

新增 `evals/computer/` manifest 和合成/脱敏 fixture，包含音乐列表、Canvas 小按钮、加载、弹窗、假成功提示；不提交个人截图。模拟播放器持有测试状态（playlistId、trackId、playing、position），仅判定器可读，Agent 不获得此状态或答案。截图定位集覆盖不同窗口位置/缩放/主题并保留未见布局作为 holdout。

**L2：真实 Driver 的 macOS 集成。**

扩展已有 `test:computer:macos`：计算器/TextEdit 回归，加原生测试窗口或受控 WebView 的像素路径；用独立读取最终控件/保存文件/测试进程状态判定，不把 Driver 的 click 回包当 oracle。记录前后台、鼠标干扰、进程/Session 清理；只操作测试创建的窗口。Browser/DOM 绕开像素的测试不得算入 CUA 定位命中率。

**L3：真实 Agent 端到端。**

扩展已有 `test:computer:agent:macos`，提示只给用户目标，不提供工具名、坐标、精确步骤或预期答案。现有 recipe 测试保留为另一类协议回归。Agent 不得读取 oracle；使用测试专用权限范围、临时数据目录和独立测试文件。完成后先由独立 oracle 验证再清理。测试清理失败也记可靠性失败，不能删除非测试窗口。

至少 10 类任务 × 20 个预先定义的初态/重复 = 每条主执行路径 200 次；路径至少包括原生多模态和文本主模型+视觉。相同初态配对比较基线/候选，随机执行顺序，区分冷热启动。覆盖缩放、焦点、慢加载、弹窗等分层；同一 fixture 重复不能冒充独立布局，置信区间同时给场景聚类结果。200 次是首轮门槛，尾延迟/低频错误不稳定时扩大样本。

**L4：网易云金丝雀。**

显式选择已登录测试环境，记录应用版本和初态。验收“每日推荐页面/队列关联证据 + 当前歌曲属于该队列 + playing + 时间推进”，不能假设第一首永远相同，也不能只看 CPU、标题或播放图标。若没有可独立读取的媒体状态，保留人工复核截图/时间序列并报告该 oracle 的限制，不把同一视觉模型自评当独立真值。检查音量/输出设备仅在任务包含“可听见”时加入。

真实账号/真实 Provider 的 L3/L4 为显式 opt-in；本次设计不执行。小样本金丝雀用于发现兼容问题，不能宣称达到 95% 全局成功率。

### 10.3 对照实验

先固定当前模型与 Driver，比较旧/新坐标和验证封装；再固定新封装比较原生多模态与文本+视觉；最后测试短动作组和传输优化。保留一个 holdout 场景集，不用来调提示词。每个失败归因标注为 discover/permission/grounding/dispatch/verification/recovery/model/fixture，不凭“失败”统一归因模型。

## 11. 观测、发布与回滚

用现有 TraceStore 记录 `runId`、operation/step 标识、view/目标匿名引用、模型/Driver/契约版本、阶段耗时、动作投递状态、验证状态、失败码、预算与重放抑制。精确坐标变换可记在受保护诊断中；默认 Trace 不复制截图、完整 AX 文本、账号、剪贴板和输入内容。必要图片只在显式诊断模式存入受保护 artifact store，明确保留期限，禁止进入 Git。

发布按契约版本逐步放量：测试环境 → opt-in 本机 → 一小组支持的应用 → 默认。初期 batch 关闭。每一步遇到错误成功、重复副作用、授权绕过或跨 Session 污染即阻断发布。

回滚只影响新 Run；已 uncertain 的账本不清空，旧 Run 不恢复重放。不能回滚到已知含混的裸坐标行为：若新坐标路径存在故障，降级禁用像素写、保留有效 AX/只读能力并明确报告。新增持久字段仅允许可选兼容字段，按现有 atomic store 写入；不引入旁路 JSON 状态。

## 12. 实施时实际运行的检查

以下是现有可用命令，不表示本次已经运行。新增 fixture/测试文件落地后再加入相应目标：

```bash
node --import tsx --import ./tests/test-environment.mjs --test tests/computer.test.ts
node --import tsx --import ./tests/test-environment.mjs --test tests/connector-capability-routing.test.ts tests/connector-action-boundary.test.ts tests/tool-ledger-sdk-error-integration.test.ts
npm run check
npm test
npm run build
```

跨 runtime/core/daemon 的包必须完整跑 check/test/build；发布前尽可能跑 `npm run ci`。修改发布 Skill/exports/入口时加 `npm run test:package`。

macOS GUI 和模型测试只在专用环境、允许操作测试应用的前提下执行：

```bash
npm run test:computer:macos
npm run test:computer:agent:macos
```

本次交付只新增这份设计文档，核对源码与现有命令、检查文档引用和格式；不修改运行逻辑，不运行真实电脑动作、模型评测或现有全量测试。开发前还需完成 Driver 坐标协议探针，并记录基线；这是 P0-B 的入口门槛，不是让实现者继续猜测坐标。
