<p align="center">
  <a href="./SECURITY.md">English</a> | <strong>简体中文</strong>
</p>

# 安全策略

MimiAgent 是面向单个可信操作系统用户的本地优先 Agent。配置允许时，它可以执行命令、修改文件、操作已认证应用并完成外部事务。它不是不可信租户的沙箱，也不能隔离同一用户身份下已经运行的任意代码。

## 支持版本

安全修复应用到 `main` 上的最新版本，旧版本不保证 Backport。条件允许时，请先在最新版本复现再提交报告。

## 报告漏洞

不要在公开 Issue 披露可利用漏洞、凭证、个人记录或私有运行产物。

请使用仓库的 GitHub Private Vulnerability Reporting。如果私密报告不可用，只创建一个不含漏洞细节的公开 Issue，请求维护者提供私密沟通渠道。

报告中请包含：

- 受影响版本和 Commit；
- 部署方式和 Security Profile；
- 前置条件和最小复现步骤；
- 预期行为与实际行为；
- 影响范围及涉及的数据或能力；
- 可选的缓解建议。

维护者会验证报告，在适用时协调修复与发布，并按报告者意愿致谢。公开披露应等待修复或双方认可的缓解方案可用。

## Security Profile

启动档位是本机能力上限：

| 档位 | 适用场景 |
| --- | --- |
| Safe | 只读检查。 |
| Workstation | 工作区写入和沙箱 Shell，不允许受信 MCP、Computer Use、Connector 事务或通用网络写入。 |
| Full Owner | 在当前操作系统账号下执行完整 owner 能力。 |

最终工具集还会与 Mode、Work Unit 角色、事件策略、能力就绪状态、路径所有权和执行账本状态取交集。Plan 始终只读。项目指令、Skill、Memory、模型回答或外部事件都不能扩大 Host 授权。

处理陌生仓库时使用 Safe 或 Workstation。Full Owner 可以通过获准工具访问当前操作系统账号能访问的资源；内置工具的私有路径过滤不是围绕 owner Shell 的操作系统沙箱。

## 核心安全不变量

- 外部 Event、网页、邮件、消息、文档和 Connector 内容始终是不可信数据，不是 Host 指令。
- Provenance 只记录来源，本身不授权。
- 用户 Session 和活跃 Run 使用不可变所有权检查，阻止陈旧工作覆盖当前状态。
- 历史裁剪和恢复时保持 Function Call 与 Result 的完整协议单元。
- 副作用 Receipt 提供 At-most-once 保护；不静默重放已开始或结果不确定的 Shell、文件、MCP、Connector 和外部事务。
- Connector 凭证与 Channel SDK 保持在隔离 Connector 进程中。
- 工作区 MCP 配置需要显式信任精确工作区。
- SubAgent 和 Team Worker 比主 owner Session 权限更窄，且不能递归委派。
- 持久状态经过校验并原子替换；不支持的未来版本失败关闭。
- Daemon 控制接口经过认证，并绑定私有本机运行目录。

详细执行模型见[架构](./docs/ARCHITECTURE.md)、[Connectors](./docs/CONNECTORS.md)和[安全评测](./docs/SECURITY_EVALS.md)。

## 凭证与敏感数据

- API Key 放在 `~/.mimi-agent/.env`、其他被忽略的私有环境文件或进程环境中。
- `.env.example` 只能包含占位符。
- Registry 只保存凭证环境变量名，不保存凭证值。
- 远程 MCP Header 应引用环境变量，不把 Token 写入 `mcp.json`。
- 不要把 Secret 放入 Prompt、Tool 参数、源码、Trace、截图、诊断包或 Issue。
- 即使命令说明产物已经脱敏，分享前也应手工检查。

认证 owner 的直接输入存在有界的临时敏感值通道，用于少量特定工作流，但环境变量配置仍是首选。Secret 原值不能作为 Tool 参数，也不能持久化到工作区。

如果 Secret 曾进入 Git 历史、终端共享、日志、Issue 或模型 Transcript，必须撤销并轮换。只删除当前文件不够。

## Skill、MCP 与 Connector

第三方 Skill 可以影响模型行为并可能包含脚本；MCP Server 可以执行本机命令或暴露远程数据；Connector 可能携带已认证外部操作和私有事件内容。

启用前：

1. 审查指令、Command、Args、环境白名单和来源。
2. 确认它能访问的精确数据和账号。
3. 从满足需求的最低安全档位开始。
4. 先验证读取行为，再启用写入或无人值守 Schedule。
5. 对支持恢复或审计的外部系统预先定义处置流程。

macOS 集成依赖授予实际 Node、Terminal 或 LaunchAgent 进程的系统权限。Screen Recording、Accessibility、Automation、Full Disk Access、Contacts、Calendar、Mail、Messages、Microphone 和 Speech Recognition 都可能暴露敏感信息。只授予已启用 Connector 必需的权限。

## 本机接口与网络边界

Unix Socket、可选 Webhook 和可选 Runtime HTTP API 只面向认证的本机使用。没有独立的认证、授权、限流和网络隔离设计时，不要把它们暴露给其他主机、不可信本机用户或公网。

不要连接不可信 MCP Server，也不要让 Agent 查询会返回敏感信息的内部服务。内置 HTTP Tool 会拒绝本机、私网、Link-local、Metadata 和不安全重定向目标，但这不会让任意外部集成自动变可信。

## 数据与诊断

私有运行状态通常位于 `~/.mimi-agent/`，可能包含 Session、Plan、Memory、Trace、Task 元数据和 Connector 状态。备份应采用与在线目录相同的保护级别。

不要提交或发布：

- `.mimi-agent/` 或其他数据根；
- Session、Trace、SQLite 数据库、WAL/SHM 文件或执行 Receipt；
- 截图、录屏、Computer Artifact、消息附件或导出邮件；
- 真实 Connector 配置、个人标识或私人知识；
- 未经人工检查的诊断包。

使用 `mimi daemon diagnostics <file>` 生成有界脱敏产物，分享前手工检查。依赖备份前使用 `mimi daemon backup verify <directory>` 校验。
