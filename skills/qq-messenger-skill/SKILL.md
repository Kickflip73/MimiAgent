---
name: qq-messenger-skill
description: 通过 macOS CuaDriver 后台读取 QQ 可见会话、总结或理解消息上下文、生成一句回复，并向联系人发送且验证文本消息。用户要求发QQ、回QQ、看看某人说了什么、总结汇总QQ消息、根据上一句回复或处理当前QQ会话时使用。用户只说“回复某人的QQ消息”而没有给正文时，不要追问；先读取该联系人上下文，再自主生成简短回复并发送。直接发送先激活本 Skill，不要先检查 QQ Connector。
---

# QQ 消息处理

把确定性的 GUI 操作交给脚本，把总结、判断和回复措辞留给模型。始终从 `use_skill`
返回的 `root` 运行脚本，不要现场重写 CuaDriver 命令。

## “回复某人的 QQ 消息”快速路径

收到类似“回复我的好乖乖QQ消息”“回一下张三的QQ”时，用户已经授权读取目标会话并发送一条合适回复。立即按顺序执行：

1. 运行 `context --to '<联系人>' --limit 20`，不要先查 Session、Activity、Memory、People 或 QQ Connector。
2. 忽略时间和系统节点，检查最后一条有效 `kind=message`：若为 `outgoing`，说明已经回复，直接报告且不要重复发送；若为 `incoming`，结合紧邻的少量上下文自主生成自然、简短、不添事实的回复。
3. 仅在最后一条有效消息为 `incoming` 时运行 `send --to '<联系人>' --msg '<生成的回复>'`。
4. 仅在 `status=sent` 时报告新回复成功；`uncertain` 时停止，不重试。

只有 context 确实不可读、没有任何可回复的 incoming 消息、联系人歧义，或回复涉及用户无法代替决定的敏感承诺时才询问用户。不要因为 Session/Memory 中没有 QQ 消息就询问；QQ 客户端上下文才是此任务的数据源。

## 路由

1. **明确联系人和发送正文**：直接执行一次 `send`，不要读取上下文或检查 Connector。
2. **总结、查看消息或依赖上下文回复**：先执行一次 `context`，再根据结构化消息完成总结或拟写回复；“回复某人的QQ消息”使用上面的快速路径。
3. **用户明确要求“回复/告诉/发出去”**：生成回复后再执行一次 `send`。用户只问“怎么回”时仅给建议，不发送。
4. **需要当前窗口之外的长历史**：明确说明 CUA 只能读取当前可见窗口，不能把快照冒充完整历史，也不要改用其他 QQ 接入方案。

## 脚本

直接发送：

```bash
python3 <root>/scripts/send_qq.py --action send --to '<联系人>' --msg '<消息原文>'
```

读取指定联系人或当前会话的可见上下文：

```bash
python3 <root>/scripts/send_qq.py --action context --to '<联系人>' --limit 20
python3 <root>/scripts/send_qq.py --action context --limit 20
```

快速检查 QQ 当前是否满足后台操作条件：

```bash
python3 <root>/scripts/send_qq.py --action status
```

使用 Shell 工具的参数传递能力安全引用用户原文，不要改写联系人或正文。一次脚本调用返回
一行 JSON：

- `status=ready`：QQ 在运行且未占前台，脚本已取得可读窗口；只读 status/context 可使用当前可见窗口；若 QQ 原本隐藏，
  脚本会临时取得非激活窗口并在返回前恢复隐藏。
- `status=sent`：已发送并通过发送前后差异验证。
- `status=context`：`messages` 是按界面顺序排列的可见快照；`direction` 为
  `incoming`、`outgoing` 或 `unknown`，`complete=false` 表示不是完整历史，
  `truncated=true` 表示受条数或文本总量上限裁剪。
- `status=failed`：发送动作尚未发生。
- `status=uncertain` 或退出码 `2`：发送可能已发生。停止且绝对不要重试。

脚本已经完成联系人规范化；失败后不要自行改用 `target` 返回值或其他昵称再跑一次。同一用户请求最多执行一次 `send`，把失败原样报告。
输入框非空时脚本会保留用户草稿并拒绝发送；不要清空、覆盖或尝试绕过。

总结时忽略 `kind=timestamp`，保留关键决定、问题、承诺和待办。生成回复时只处理尚未被后续
`outgoing` 覆盖的最后一条 `incoming` 消息；方向来自界面对齐推断，不足以确认时使用中性措辞，不虚构发送者。

## 安全边界

- 禁止前置或激活 QQ、`osascript`、前台 dispatch、像素点击和全局键盘输入。
- QQ 已运行但隐藏时，脚本可以获取一次临时“后台窗口租约”：只允许
  `launch_app` 返回 `self_activation_suppressed=true`，并且每次写操作前后都确认
  QQ 未成为前台；完成后使用目标进程和窗口恢复原隐藏状态。
- QQ 窗口即使“可见但不在前台”，默认也不操作：切换会话可能改变你下次看到的页面或已读状态。
  只有隔离实验显式设置 `MIMI_QQ_ALLOW_VISIBLE_BACKGROUND=1` 才允许该兼容路径。
- 所有 QQ 调用共用一个本机文件锁，避免两个后台任务同时切换会话、覆盖草稿或重复发送。
- QQ 位于前台、进程在操作中变化，或任一检查发现用户已开始使用 QQ 时，立即停止。
  若用户在租约期间主动切到 QQ，脚本不得把 QQ 隐藏回去。
- 后台窗口租约失败、无法证明未抢焦点或无法恢复原隐藏状态时失败关闭；若消息已经
  确认发送，则保留 `sent` 结果并返回 `cleanupWarning`，绝不重复发送。
- 禁止在脚本之外手动 `set_value`、`press_key` 或点击发送。
- 目标不匹配、昵称歧义、窗口不可读时失败关闭。
- 上下文不足时说明限制，不把可见窗口快照冒充完整聊天记录。
