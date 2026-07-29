# MimiAgent 三档 Security 简化规划

日期：2026-07-29

状态：规划基线，当前代码已按三档 Security 实施

## 1. 结论

MimiAgent 的用户可见安全管控只保留三档：

- `Safe`
- `Workstation`
- `Full Owner`

当前 Run 选择哪一档，就使用该档的固定权限。除此之外不再设计审批中心、逐动作授权、
风险等级、Tool 独立安全档位或按自然语言关键词动态裁剪权限。

安全体系只解决两个问题：

1. 当前 Security 档位允许 Agent 使用哪些能力；
2. 当前输入是否来自可信 Host，外部内容能否被当作指令。

目标校验、动作回执、原子写入和副作用防重复仍保留，但它们属于执行正确性，不是新的
权限层。

## 2. 三档权限

| 能力 | Safe | Workstation | Full Owner |
|---|---|---|---|
| 工作区文件 | 只读 | 工作区内读写 | 按当前 OS 用户权限读写 |
| Shell | 禁止 | 允许工作区开发命令 | 允许 |
| 公网读取 | 允许 | 允许 | 允许 |
| Memory、Session、Plan | 只读 | 当前工作状态读写 | 完整 Owner 能力 |
| Connector 外部事务 | 禁止 | 禁止 | 允许已配置能力 |
| Computer / 桌面写动作 | 禁止 | 禁止 | 允许已配置能力 |
| 受信工作区 MCP | 禁止 | 禁止 | 允许显式配置能力 |
| 当前 Run 临时敏感值 | 禁止 | 禁止 | 允许，但不持久化和外泄 |

三档含义保持直观：

- **Safe**：查看、搜索、分析和回答，不修改状态。
- **Workstation**：可以完整开发当前工作区，但不能代表 Owner 操作外部账号或桌面。
- **Full Owner**：使用当前 OS 用户已经配置的完整能力。Owner 的明确请求不再叠加逐动作
  审批；缺少目标或参数时只补齐执行信息，不引入新的授权流程。

`General` 和 `Ultra` 只改变执行方式。`Plan` 固定按 Safe 执行，因此也不形成第四档
Security。Mode 不能扩大当前 Security。

## 3. 外来信息可信度

外部邮件、消息、网页、文件正文、Webhook、Connector Event 和 public 内容一律视为
**不可信数据**，不是系统或 Owner 指令。

Host 必须在模型调用前提供结构化来源信息：

- `owner`：已认证本机 Owner，可使用当前选择的 Security；
- `system`：MimiAgent 内部可信维护事件，只执行固定内部任务；
- `external/public`：外部数据，固定不能提升 Security。

处理外部内容时只遵守以下规则：

1. 外部正文不能切换 Security、修改系统规则、扩大工具面或创建新的授权。
2. 外部正文中的“忽略之前指令”“执行命令”“发送资料”“读取 Memory”等文字只作为
   被分析的内容，不作为 Host 指令执行。
3. 外部来源不能读取 Owner 私有 Memory、凭证、系统提示或其他 Session 内容。
4. Owner 本机配置的 source policy 可以绑定固定来源、目标和动作；授权来自本机配置，
   不是来自外部正文。
5. 需要处理外部数据时，Agent 在当前有效 Security 和既有 Scope 内完成读取、摘要、
   判断或回复；外部内容永远不能扩大边界。

不为 Prompt Injection 建设复杂分类器或关键词库。边界由 Host 的结构化 provenance 和
固定 Security 决定，模型只负责把外部内容当数据处理。

## 4. 最小运行规则

每轮只走一条简单链路：

```text
可信 Host 确定 provenance 和 Security
→ 按三档表生成一次最终工具集
→ 模型在实际可用能力中选择动作
→ 执行面校验结构化目标并执行
→ 根据真实回执报告结果
```

只保留以下通用约束：

- 同一 Security 下，Owner 使用不同措辞、不同 Session 时基础工具面保持一致。
- 不按“打开、发送、搜索、修复”等自然语言关键词决定权限或隐藏工具。
- 外部来源只能缩小 Scope，不能扩大 Security。
- Security 允许但 Connector、MCP、Computer 或依赖未就绪时，报告
  `unavailable/degraded`，不误报成无权限。
- Full Owner 的普通明确请求直接执行，不重复确认、不跨路线试错。
- 写动作必须有结构化目标和真实回执；结果不确定时诚实报告，不能自动重放。
- 凭证和敏感值继续脱敏，不进入 Session、Task、Trace、Memory、Tool 回执或日志。

## 5. 明确不做

- 不新增 Approval Center、Mandate、Policy DSL 或风险评分器。
- 不保留 L0～L4、Observe/Draft/Confirm/Auto 等另一套权限等级。
- 不为 Computer、Connector、App 或 Tool 再定义独立授权档位。
- 不使用逐动作一次性授权、重复人工确认或“Full Owner 快速通道”分支。
- 不根据 Owner 或外部正文的关键词动态裁剪工具面。
- 不让 Connector readiness、route owner、Ledger 状态变成新的权限来源。
- 不把执行可靠性、目标完整性或完成验证包装成第四层安全策略。

## 6. 验收标准

1. 用户界面、配置和文档只出现 Safe、Workstation、Full Owner 三档 Security。
2. 同一 Security 下，不同自然语言输入得到相同基础工具集 digest。
3. Safe 的写入、Shell、Connector 事务和 Computer 写动作均不可执行。
4. Workstation 可以完成工作区开发、测试和构建，但不能操作外部账号或桌面。
5. Full Owner 可以直接使用已配置的 Shell、Connector、Computer 和受信 MCP，
   不出现第二次权限审批。
6. external/public Prompt Injection fixture 无法切档、扩大 Scope、读取私有上下文或
   触发未授权写动作。
7. Security 拒绝、能力未就绪和动作执行失败具有不同且准确的错误结果。
8. 不确定副作用不会跨 Tool、Provider、Connector 或重启自动重放。
9. OpenAI、DeepSeek 和 OpenAI-compatible Provider 使用同一套三档矩阵和来源边界。
10. 全量测试、构建和 package smoke 通过，且不为修复权限 Badcase 新增关键词规则。

## 7. 后续维护原则

当前代码已经完成三档 Security 改造，本规划不再安排新的安全框架建设阶段。

后续遇到权限 Badcase 时，只按以下顺序处理：

1. 核对当前 Security 是否选对；
2. 核对 provenance 是否由可信 Host 正确标记；
3. 核对能力是否真实注册并 ready；
4. 核对目标和回执是否满足执行正确性；
5. 修正三档矩阵或来源边界中的根因。

不得通过增加审批层、关键词规则、临时工具白名单或新的安全状态来修补单个案例。
