# Computer Use P0 实施记录

2026-11-05。本次落实评测假阳性、坐标和目标绑定、结果验证、权限入口四项基础修复。保留工作区原有未提交改动，未提交 Git。以下是首轮 P0 结果；后续 Driver 重复投递修复及真实模型 E2E 结果见 [CUA 单次点击修复记录](CUA_SINGLE_CLICK_FIX.md)。

## 改动与可复验结果

| 问题 | 实现 | 回归证据 |
| --- | --- | --- |
| 对话或输入含有 `56` 就被评为成功 | `scripts/run-mimi-computer-e2e.ts` 使用独立 Driver session 读取本轮启动窗口的 AX value；`scripts/lib/computer-e2e-oracle.ts` 排除标题、提示词、模型回答、按钮文字、错误窗口和模糊值 | 只回显答案、156、其他窗口、多个候选值均失败；唯一精确值通过 |
| 不同观察混用、模型自行换算坐标 | `types.ts`、`manager.ts`、`tools.ts` 返回并要求 `viewRef`；完整截图标明 `image_px/imageSize`，像素原样传入 Driver；没有完整截图或只有裁剪图不能发像素动作 | 2 倍图片、负屏幕原点不改变输入；跨 Run、旧视图、几何变化、等待期间视图被替换均无法投递 |
| AX index 可能随快照变化 | `cua-driver-client.ts` 保留 `element_token`，存在时替代 `element_index` | 参数回归覆盖 token 和 Driver 嵌套 foreground delivery |
| 投递成功冒充业务成功 | 新增 `verification.ts`，observe/act 支持 `verify: {role, identifier?, label?, equals}`；区分 `not_requested/passed/failed/unavailable` | 唯一完整语义 value 精确匹配才能通过；缺失、歧义、截断不能通过；只读验收无需额外写动作 |
| 读回失败仍返回成功、通过新截图重试不确定动作 | UI 投递及关键读回共用动作锁；读回失败转 uncertain；ActionIntent 使用稳定窗口身份，与 viewRef 分离；同窗口不同 UI 动作类别也受 fence 限制 | SDK 同一 callId 重送复用旧回执；uncertain 后刷新视图并改用按键仍不能投递 |
| 长期 Goal 接受未验证回执 | `completion-coordinator.ts`、`core/completion.ts` 只允许有通过结果断言的 Computer 证据参与验收 | 旧回执、仅 `ok:true`、`verified:false` 不通过；匹配契约的通过断言可以通过 |
| 反复空点 | Run 内保存相同动作和窗口状态摘要；连续两次相同动作无可观察进展后拒绝第三次；视觉写入前检查读回截图额度 | 两次投递后第三次被拒绝；没有追加自动写重试 |
| 通过别名桌面 Connector 绕开 Computer 权限 | 新增 `daemon/desktop-action-policy.ts`；能力发现、普通调用、capability 调用、Task proxy、read probe 均校验 | 改名 Connector、把 `activate_app` 标成 read 也不能写；保留非 GUI 业务能力与只读剪贴板 |

模型指令、`skills/computer-use/SKILL.md`、中英文架构文档和 CHANGELOG 已同步。旧模型调用如果省略 UI 动作的 `viewRef`，现在会要求重新观察，不会兼容为“随便使用最近窗口”。

## 验证实际执行

- 新增最初 4 个 Computer 回归在修复前全部失败；Connector 别名旁路回归在修复前失败。
- `npm run check`：通过。
- `npm test`：1,279 通过，0 失败，0 跳过；耗时约 125 秒。这是软件回归覆盖，不是 GUI 任务成功率。
- `npm run build`：通过。
- `npm run test:package`：通过。
- `node scripts/check-dependency-direction.mjs`：通过。
- `git diff --check`：通过。
- `node --import tsx scripts/run-computer-grounding-probe.ts`：独立 Cocoa 测试窗口，两次截图像素命中通过；**单次事件投递检查失败，进程按设计退出 1**。

真实探针使用 CUA Driver 0.16.0，窗口 600×432，截图 1200×864。截图坐标 `(200,264)` 实际命中内容坐标 `(100,100)`；移动窗口后仍命中。两次调用各观察到 **2 个 mouseDown**，而预期为 1。结果明确输出 `groundingPassed:true, singleDeliveryPassed:false`，没有把坐标正确包装为整体可靠性通过。探针仅创建和清理自己的进程/临时文件，没有修改 Driver 全局配置或权限。

## 当前边界与后续验证

- 首轮发现的重复事件已定位到 Driver 双通道投递，并在本地修复版通过原生窗口、WebView 及真实 MimiAgent 回归；完整证据、启用状态与未覆盖范围见上述修复记录。官方安装副本仍保留原版。
- 本次确定性结果断言覆盖唯一 AX 元素值。视觉理解、播放器时间推进、动态动画等条件尚未拥有同等强度的自动验收，不能以 `AXWindow` 或图片变化代替成功证据。
- 无进展保护是保守的相同动作/状态保护，尚不是完整的任务语义进展检测。90 秒任务预算、2 张最终验收预留、视觉专用超时、完整 model/vision/driver/wait 分阶段 Trace 属于设计中尚未落地的后续项；当前只在视觉写入前保证尚有一次读回额度。
- 未运行真实模型驱动的网易云、Calculator/TextEdit Agent 评测，因此没有端到端成功率或平均耗时提升百分比。下一次真实评测必须使用已修正的独立 oracle，并分别报告成功率、错误成功报告率、p50/p95 耗时、重复副作用与资源泄漏。
- 原有语音/UI 等工作区变更没有回滚。测试期间也出现了其他文件的并行修改，本次仅修改上述 Computer 相关代码及必要共享边界。
