<p align="center">
  <a href="../CLI.md">English</a> | <strong>简体中文</strong>
</p>

# CLI 与 Daemon 参考

`mimi` 同时是交互式客户端和本机 Daemon 管理命令。使用 `mimi --help`、`/help` 和 `mimi daemon --help` 查看当前安装版本的精确命令集。

## 顶层命令

| 命令 | 用途 |
| --- | --- |
| `mimi` | 打开交互终端；共享 Daemon 会在需要时自动启动。 |
| `mimi "task"` | 提交一次性任务并流式展示结果。 |
| `mimi --help` | 显示顶层用法。 |
| `mimi --version` | 输出安装版本。 |
| `mimi provider list` | 列出模型 Registry 和当前全局默认 Target。 |
| `mimi provider add <provider/model> ...` | 注册 Provider Target 和能力。 |
| `mimi provider set <provider/model>` | 修改下一 Run 使用的 Registry 全局默认值。 |
| `mimi provider test <provider/model>` | 测试已注册 Target。 |
| `mimi daemon --help` | 显示 Daemon 管理命令。 |

Provider 示例和参数语义见[配置参考](./CONFIGURATION.md)。

## 交互式斜杠命令

### Runtime 与模型

| 命令 | 用途 |
| --- | --- |
| `/status` | 查看模型、Session、Runtime 和扩展状态。 |
| `/security [profile]` | 查看不可变的启动安全档位；运行时修改请求会被拒绝。 |
| `/models` | 列出精确模型 Target、能力和配置状态。 |
| `/model` | 查看或选择模型 Target。 |
| `/model current` | 查看当前 Target。 |
| `/model inspect <target>` | 查看一个 Target 的详细状态。 |
| `/model use <target>` | 为当前 Session 固定 Target。 |
| `/model auto` | 清除 Session 固定值并使用路由。 |
| `/model routes` | 查看场景路由。 |
| `/model route <scenario> <target|auto>` | 设置或清除场景路由。 |
| `/model doctor [target]` | 检查 Target 就绪状态。 |
| `/mode [name]` | 查看或切换 General、Plan、Ultra。 |
| `/output [level]` | 调整终端细节等级。 |
| `/tools` | 列出当前 Run 实际可用工具。 |

模型和 Mode 变化在安全 Run 边界生效；Security Profile 只能通过启动配置修改。无论启动档位如何，Plan 都保持只读。

### Session 与历史

| 命令 | 用途 |
| --- | --- |
| `/new [id]` | 创建并切换到新 Session。 |
| `/sessions` | 选择最近 Session。 |
| `/switch <id>` | 按 ID 切换 Session。 |
| `/history` | 查看当前 Canonical Session 历史。 |
| `/clear` | 清空当前 Session。 |
| `/undo [run-id]` | 列出或预览可安全撤销的文件变更。 |
| `/undo <run-id> --apply` | 显式执行选中的撤销。 |
| `/retry` | 重新执行当前终端进程中的上一条输入。 |
| `/exit` | 关闭当前 CLI；Daemon 和已接受的后台任务继续运行。 |

### Context、指令与扩展

| 命令 | 用途 |
| --- | --- |
| `/context` | 查看 Context、Memory、Plan 和请求预算。 |
| `/compact` | 归档较早 Context，同时保留最近完整轮次。 |
| `/instructions` | 查看已加载的 Soul 和项目指令来源。 |
| `/skills` | 列出发现的 Skill 及其来源。 |
| `/skills reload` | 重建 Skill Registry。 |
| `/skills active` | 查看当前 Session 激活的 Skill。 |
| `/skills deactivate <name>` | 停用当前 Session Binding。 |
| `/skills enable|disable <project|user> <name>` | 持久设置项目或用户范围的启停状态。 |
| `/mcp` | 查看 MCP Server 状态和工具数量。 |
| `/mcp reload` | 重新连接已配置 MCP Server。 |

### Memory、Plan 与任务

| 命令 | 用途 |
| --- | --- |
| `/memory status` | 查看 MemoryHub 健康状态。 |
| `/memory list|search|read` | 只读检查 Memory。 |
| `/memory ingest|capture` | 编译来源或已完成 Session Round。 |
| `/memory lint|conflicts|audit` | 检查 Memory 质量和 Provenance。 |
| `/memory forget` | 删除 Memory 页面并保留 Suppression 状态。 |
| `/memory reindex|maintain` | 重建派生索引或执行有界维护。 |
| `/plan` | 查看当前多步骤 Plan。 |
| `/team` | 查看 Ultra Team 任务、依赖和结果。 |
| `/goal [objective]` | 查看或设置持久 Goal。 |
| `/resume` | 根据 Goal、Plan、Team 和 Checkpoint 发起新 Run。 |
| `/tasks [limit]` | 列出最近后台任务。 |
| `/task <id>` | 查看一个后台任务。 |
| `/task pause <id>` | 请求安全暂停。 |
| `/task resume <id> [context]` | 恢复暂停或阻塞的任务。 |
| `/task cancel <id> [reason]` | 请求取消。 |
| `/confirm-send <text>` | 在符合条件的个人消息 Session 中确认精确正文。 |

## 键盘操作

| 按键 | 动作 |
| --- | --- |
| `Esc` | 请求取消当前 Run。 |
| `Shift+Tab` | 切换执行 Mode。 |
| `Shift+Enter` | 插入换行。 |
| `Command+Left/Right` | 在 macOS 终端中移动到行首或行尾。 |
| `Up/Down` | 浏览历史或命令候选。 |
| `Tab` | 补全当前命令。 |
| `Enter` | 提交当前输入。 |

## Daemon 生命周期与健康状态

| 命令 | 用途 |
| --- | --- |
| `mimi daemon start` | 初始化私有状态并启动服务。 |
| `mimi daemon stop` | 安全停止。 |
| `mimi daemon restart [--force]` | 重启；`--force` 仍拒绝不安全的在途副作用。 |
| `mimi daemon status [--json]` | 输出人工可读或结构化健康状态。 |
| `mimi daemon doctor` | 执行只读就绪检查。 |
| `mimi daemon diagnostics [file]` | 写入脱敏诊断包。 |

## 备份与恢复

| 命令 | 用途 |
| --- | --- |
| `mimi daemon backup [directory]` | 创建带 Hash 和 SQLite 完整性检查的恢复备份。 |
| `mimi daemon backup verify <directory>` | 校验文件、摘要和数据库完整性。 |
| `mimi daemon restore <directory>` | 只允许离线恢复到不存在的空数据根。 |

依赖备份前始终先验证。Restore 会明确拒绝覆盖在线或已有数据的 Runtime Root。

## 队列检查与恢复

| 命令 | 用途 |
| --- | --- |
| `mimi daemon activity [limit]` | 查看积压、失败和近期活动。 |
| `mimi daemon events|tasks|runs|outbox [limit]` | 列出一种持久控制面记录。 |
| `mimi daemon show <type> <id>` | 查看 Event、Task、Run、Outbox 或 Schedule 详情。 |
| `mimi daemon retry task <id>` | 重新排队 Dead-letter Task。 |
| `mimi daemon retry outbox <id>` | 重试投递，可能产生重复投递。 |
| `mimi daemon archive outbox <id>` | 归档失败投递。 |

确认外部副作用状态之前不要重试记录。MimiAgent 不会静默重放结果不确定的 Shell、文件、MCP、Connector 或网络事务。

## Connector、Attention 与 Schedule

| 命令 | 用途 |
| --- | --- |
| `mimi daemon connectors [reload]` | 查看或重载 Connector 状态和能力。 |
| `mimi daemon connectors enable|disable <id>` | 原子修改已有 Connector 的启用状态。 |
| `mimi daemon probe <profile>` | 执行认证的固定只读就绪 Probe。 |
| `mimi daemon attention [reload]` | 查看或重载 Attention 策略。 |
| `mimi daemon digest [limit]` | 查看待简报摘要。 |
| `mimi daemon brief` | 立即生成主动简报。 |
| `mimi daemon schedule list` | 列出 Schedule。 |
| `mimi daemon schedule at <ISO-time> "task"` | 创建一次性 Schedule。 |
| `mimi daemon schedule every <10m|1h> "task"` | 创建周期 Schedule。 |
| `mimi daemon schedule remove <id>` | 删除 Schedule。 |

事件和操作契约详见 [Attention](../ATTENTION.md) 与 [Connectors](../CONNECTORS.md)。
