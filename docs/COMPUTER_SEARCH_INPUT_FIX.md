# 搜索输入与后台导航回归（2026-11-05）

## 用户 Badcase 的根因

“网易云播放薛之谦的歌单”停在输入框，不是单纯识别不出输入框。

1. 模型传 `keys:["cmd+a"]`，旧适配器按数组长度选择 `press_key`，把整段字符串当成一个键。Driver 0.16.0 实际返回 exit 0、纯文本 `press_key failed: Unknown key name: cmd+a`。
2. 适配器按 JSON 解析，原始诊断在包装异常和执行账本中丢失。模型只能看到通用 uncertain。
3. uncertain 正确冻结整个目标窗口，但旧提示写成同一 action family，让模型误以为换 click 或等待可以恢复。
4. 主模型同时看到了窗口截图像素和 AX 屏幕坐标，花时间反复推算缩放。

## 本次修正

本轮涉及文件：`src/extensions/computer/{keyboard,types,cua-driver-client,manager,tools}.ts`、`src/runtime/{instructions,tool-ledger}.ts`、`skills/computer-use/SKILL.md`、`tests/computer.test.ts`、`tests/fixtures/computer-grounding-probe.swift`、`scripts/run-computer-grounding-probe.ts`、`scripts/lib/computer-probe-agent.ts`、本报告及 `CHANGELOG.md`。修改前保存了主要 Computer 文件的快照；没有重置、提交或覆盖其他功能的未提交改动。

- `keyboard.ts`、`types.ts`、`cua-driver-client.ts`：组合键标准化；别名如 Enter、Backspace 转为 Driver 键名；非法按键在投递前拒绝；组合键走 hotkey。非 JSON 响应保留有界诊断，仍按 uncertain 处理，不擅自判定无副作用或重试。
- `manager.ts`：模型视图明确 window / desktop 与截图原点；隐藏 AX 屏幕 frame，内部目标/几何校验保持不变。
- `tools.ts`、`instructions.ts`、Computer Skill：视觉问题说明窗口像素坐标；动作读回聚焦目标附近；替换文本先全选删除再输入，避免像素 type_text 再聚焦取消选区。
- `tool-ledger.ts`：保留具体错误，明确同一窗口所有写动作冻结，等待不解冻。

## 真实测试发现的第二个问题

快捷键修好后，实际 MimiAgent 能输入“薛之谦”，但仍在搜索建议列表反复点击。用修复版 Driver 对同一截图中的同一坐标做对照：后台投递返回 `effect:unverifiable`，画面不变；前台投递立即进入搜索结果页。此项证据仅说明当前网易云搜索建议的后台兼容性问题，不推论所有后台动作失效。

底层已经支持前台投递，模型工具却没有该参数。本次暴露可选 `dispatch` 请求和当前 `availableDelivery`。请求不等于授权：Host 仍检查 Run access、应用限制、viewRef、目标身份；background-only 会在投递前拒绝 foreground。不会在不可验证的投递后自动重放；模型仅可在读回确认无效且导航可安全重试时显式尝试，uncertain 冻结仍优先。

Daemon 的来源策略与 `MIMI_COMPUTER_DEFAULT_ACCESS` 是两层配置。运行时默认 foreground 不会覆盖来源策略的 background。真实测试通过独立临时 assistant 配置，只为 local-cli 测试授权网易云 foreground；没有扩大用户常用 Daemon 的权限。

## 可重复验证

```sh
npm run check
node --import tsx --test tests/computer.test.ts tests/computer-verification.test.ts
npm test
npm run build
MIMI_PROBE_KEYBOARD=1 MIMI_PROBE_ITERATIONS=2 \
  node --import tsx scripts/run-computer-grounding-probe.ts
```

原生测试窗口独立记录鼠标/键盘事件、文本值和提交计数：复现原始非法快捷键；修复后清空预填文本、输入“薛之谦”、Enter 仅提交一次。探针需要真实 macOS 窗口和已授权 Driver，不属于无密钥单测。

真实模型探针 `scripts/lib/computer-probe-agent.ts` 使用隔离数据目录、实际 CLI → Daemon → 配置模型 → Computer 工具。启动前禁用测试目录中的所有 Connector，避免环境告警混入。可显式设置 `MIMI_PROBE_ACCESS=foreground` 和 `MIMI_PROBE_APPS=com.netease.163music`；默认仍为 background。模型请求完成不等于验收通过，必须另读界面确认实际播放。

本次不声称整体成功率、P95 延迟或长期可靠性已有统计改善；单场景完成也不能代替多轮、多个初始状态的回归。

## 当前验证记录与限制

- 类型检查、构建通过；Computer 专项 91/91 通过；最后一轮全量 1298/1298 通过。工作树有其他并行改动，测试总数随工作树变化，不将增加的全部用例归为本次修复。
- 前一轮全量曾有一个既有 desktop Connector 的激活记录断言失败；该文件单独重跑 2/2、随后全量重跑通过。没有为使其通过修改该 Connector 或测试。
- 原生真实窗口：输入值精确为“薛之谦”，提交计数为 1；鼠标单击探针两轮通过。
- 未引导的实际模型流程仍未完成播放：出现后台无效动作重复、将 ledger 的投递 confirmed 解释为焦点已确认，以及视觉解读/推理占满 30 秒 viewRef 有效期的情况。保留 30 秒过期拦截，没有延长旧截图寿命来使测试通过；本次压缩视觉读回只减少无关输出，不保证消除模型时延。
- 常用 Daemon 的正常重启因活动事件被拒绝，未强杀。新构建只在隔离 Daemon 中跑了真实模型测试；常用实例尚未加载本轮新代码。
- 明确指定 foreground 的引导测试进入了“薛之谦四巡《万兽之王》歌单（正确顺序）”，并投递了播放全部点击，但独立截图两次仍显示旧曲《偏向》、暂停。随后视觉检查超时，整轮约 360 秒，无完成 finalization。因此该轮也计为失败，不声称播放成功。
- 探针补充检查完成 finalization、工具记录与非空输出；CLI 正常退出或返回空文本不能单独成为模型回归通过的证据。最终仍需独立窗口状态断言。

下一步应先把投递确认与控件/业务状态验证在模型输出上进一步区分，并设计带时延预算的视觉定位回路，再验证自动选择前台路径；不能把上述未完成的真实任务计入成功样本。
