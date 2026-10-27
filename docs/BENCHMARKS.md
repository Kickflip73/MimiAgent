# MimiAgent 本地容量基准

## 阶段一日常任务验收

`npm run eval:usability` 使用当前配置的真实 Provider，顺序执行
`evals/usability-cases.json` 中 20 个固定日常任务。覆盖普通问答、文件读取与修改、Shell、Web、
按需能力发现、Session、模式切换、Skill、Memory、Plan 只读边界和失败如实呈现。

每个用例都在独立的系统临时工作区和数据目录运行，Computer 与 MCP 默认关闭；用例只能修改自己
的临时文件，结束后自动清理。验收同时检查实际工具轨迹、禁止工具、输出关键内容、文件结果和
单用例耗时上限。该命令会产生真实模型调用并需要 Provider 凭证，因此属于显式 canary，不进入
无凭证单元测试：

```bash
npm run eval:usability
```

日常开发先运行 `npm test`。准备合并阶段一改动时，在同一模型、网络和机器条件下连续运行
`eval:usability`，记录通过数与耗时；20 项未全部稳定通过时，不视为阶段一退出。

## 本地容量

`npm run bench:capacity` 在系统临时目录创建隔离状态，使用真实
`MimiStore`、`FileSession` 和 `SqliteMemoryCatalog` 测量：

- Event 入库并路由 Task 的吞吐；
- queued Task 的带租约 claim 吞吐；
- 多 Session 多轮 transcript 写入与摘要枚举；
- Memory 文档重建写入与 FTS/BM25 lexical recall；
- 本轮持久文件总容量。

默认规模用于开发机快速对比：

```bash
npm run bench:capacity
```

压力规模通过显式参数控制：

```bash
npm run bench:capacity -- \
  --events 10000 \
  --taskClaims 1000 \
  --sessions 1000 \
  --roundsPerSession 100 \
  --memories 10000 \
  --memoryQueries 1000
```

参数支持 `--name value` 和 `--name=value`。默认运行完成后删除临时目录；
只有显式传 `--keep` 才保留并在 JSON 中返回 `workingDirectory`。脚本不会读取
`~/.mimi-agent`、工作区 Session、私人 Memory 或 Provider Key，也不会调用模型
或公网。

输出是带 `schemaVersion` 的 JSON，包含 Node、平台、CPU/内存环境，实际操作数、
毫秒耗时、每秒吞吐、最终 Task 状态、命中数和磁盘字节数。比较版本时应固定同一
机器、Node 版本、参数和空闲条件；至少运行三次并报告中位数。这个基准用于发现
回归，不承诺跨机器的绝对 SLO。

建议发布前保留以下两档结果：

- `10k`：上面的日常压力规模，用于 PR/版本对比；
- `100k`：把 `events` 和 `memories` 提升到 `100000`，用于迁移或存储改造前后
  的人工容量评估。

并发公平性、真实 Provider canary 和 Prompt Injection eval 属于不同测试面，
不应混进本地存储吞吐数字。
