<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

# MimiAgent 文档

这里把用户指南、运维参考、架构说明、兼容契约和项目治理分开组织。请从能回答当前问题的最短文档开始；根 README 有意只保留项目概览。

## 按目标选择文档

| 我想要…… | 阅读 |
| --- | --- |
| 安装 MimiAgent 并开始第一次对话 | [快速入门](./zh-CN/GETTING_STARTED.md) |
| 配置 Provider、安全档位、数据目录、MCP 或 Connector | [配置参考](./zh-CN/CONFIGURATION.md) |
| 查找终端、斜杠或 Daemon 命令 | [CLI 与 Daemon 参考](./zh-CN/CLI.md) |
| 理解运行时和状态模型 | [详细架构](./ARCHITECTURE.md) |
| 新增 Connector 或查看协议 | [Connector Protocol](./CONNECTORS.md) |
| 贡献代码或文档 | [贡献指南](../CONTRIBUTING.zh-CN.md) |
| 报告漏洞或检查威胁模型 | [安全策略](../SECURITY.zh-CN.md) |

## 用户指南

| 文档 | English | 简体中文 |
| --- | --- | --- |
| 项目概览 | [README](../README.md) | [README](../README.zh-CN.md) |
| 快速入门 | [Guide](./GETTING_STARTED.md) | [指南](./zh-CN/GETTING_STARTED.md) |
| 配置 | [Reference](./CONFIGURATION.md) | [参考](./zh-CN/CONFIGURATION.md) |
| CLI 与 Daemon | [Reference](./CLI.md) | [参考](./zh-CN/CLI.md) |

## 架构与运维

| 文档 | 范围 | 语言 |
| --- | --- | --- |
| [架构概览](./ARCHITECTURE.en.md) | 模块边界、运行通道、状态所有权、工具策略和扩展模型 | English |
| [详细架构](./ARCHITECTURE.md) | 权威设计不变量与运行时细节 | 简体中文 |
| [注意力与主动简报](./ATTENTION.md) | Attention 策略、日常例程、Standing Orders 和摘要 | 简体中文 |
| [Connector 协议](./CONNECTORS.md) | NDJSON 协议、Action Bridge 和内置 Connector 示例 | English 与简体中文 |
| [Computer Use](./COMPUTER_USE.md) | 原生电脑观察/操作契约与安全边界 | 简体中文 |
| [本地容量基准](./BENCHMARKS.md) | 可复现的本地基准范围和结果解释 | 简体中文 |

## 契约与评测

| 文档 | 用途 |
| --- | --- |
| [公共 API](./PUBLIC_API.md) | 支持的 Package 入口和兼容规则 |
| [Provider 契约](./PROVIDER_CONTRACTS.md) | 离线 Provider 行为与 Fixture 契约 |
| [Provider Canary](./PROVIDER_CANARY.md) | 可选的真实 Provider 冒烟测试 |
| [安全评测](./SECURITY_EVALS.md) | 权限与 Prompt Injection 测试矩阵 |
| [仓库边界](./REPOSITORY_BOUNDARIES.md) | 产品、发布包、实验资产与用户工作区的归属 |

## 设计记录

这些文档用于解释历史决策或实施过程，可以帮助理解背景，但当前行为以代码、测试和架构契约为准。

| 文档 | 状态 |
| --- | --- |
| [状态存储决策](./STATE_STORAGE_DECISION.md) | 架构决策记录 |
| [Agent Skills 互操作计划](./AGENT_SKILLS_INTEROPERABILITY_PLAN.md) | 已完成的实施计划 |

## 项目治理

- [Contributing](../CONTRIBUTING.md) / [贡献指南](../CONTRIBUTING.zh-CN.md)
- [Security](../SECURITY.md) / [安全策略](../SECURITY.zh-CN.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md) / [行为准则](../CODE_OF_CONDUCT.zh-CN.md)
- [更新日志](../CHANGELOG.md)
- [许可证](../LICENSE)

## 文档约定

- 新增顶层公共文档默认使用英文；简体中文翻译使用同目录 `.zh-CN.md`，或放在 `docs/zh-CN/`。
- 两种语言中的命令名、环境变量、路径和代码标识必须保持一致。
- 用户可见行为发生变化时，应在同一个 Pull Request 中同步更新相关中英文指南。
- 架构细节进入架构文档，安装步骤进入用户指南，兼容承诺进入契约文档，阶段性调研进入设计记录。
- README 不重复长篇能力和配置清单，而是链接到唯一的详细信息来源。
