# Provider Contract

MimiAgent 的 OpenAI、DeepSeek 与通用 OpenAI 兼容 Provider 共享同一能力层。可机器读取的基线位于
`evals/provider-contracts.json`，固定每个 Provider 的：

- 必需 API Key 环境变量；
- 默认模型与 transport；
- context window、输出预留和图片输入能力；
- 跨 Provider Session message ID 的保留/清洗规则。

运行：

```bash
npm run test:provider-contract
```

测试不会调用 Provider 或公网。它同时实例化三类本地 model adapter，核对默认
profile、缺失 Key 的 fail-fast 行为、message ID 可移植性、Tool 名唯一性，以及
HTTP Tool JSON Schema 不包含 Chat Completions 不兼容的 `format: uri` /
`propertyNames`。

Provider 特有差异必须先更新 fixture 和本文件，再修改实现；其余 Runtime、权限、
Session、Tool 和完成语义应保持一致。真实 Provider canary 是单独的 opt-in 评测，
不能用来替代这个确定性 contract。

`openai-compatible` 使用 OpenAI Chat Completions adapter，并要求
`MIMI_PROVIDER_API_KEY`、`MIMI_PROVIDER_BASE_URL` 与 `MIMI_MODEL`。这组稳定的通用
变量避免把厂商名称写入 Runtime；后台 Task worker 会通过受限 credential 通道传递
API Key，并从经过 schema 校验的 `AppConfig` 获取 endpoint 与模型配置。

Chat Completions 的 Provider 输入兼容化必须发生在 model adapter 的每次请求边界，
不能只在 Session 历史首次合并时执行。SDK 可能把 Provider 的同一个 assistant 响应拆成
`reasoning -> 可见文本 -> Tool call` 三个 item；发送前必须把这些碎片重新合并成一个同时
携带 `content`、推理字段和 `tool_calls` 的合法 assistant 消息。携带 Tools 的后续请求必须
保留所有历史 assistant 轮次的推理，包括没有 Tool call 的回答轮以及值为空字符串的
`reasoning_content`；只有无法归属到 assistant 输出的孤立 reasoning 才能从请求视图移除。
请求视图的重组不得回写 canonical Session；Session 只保存一份推理正文和一个有界方言
标记，不能把完整推理复制到每个并行 Tool call。切换到其他 transport 时必须从请求视图
移除该内部标记。这一约束同样适用于同一 Run 内 Tool 执行后的后续模型调用、SubAgent
和 Team worker。

`/models` 与 `model_control list` 只列出本地注册，不发起 Provider 请求。显式执行
`/model doctor [provider/model]` 时，OpenAI-compatible adapter 会向目标模型发送一个
输出上限为 1 token 的 Chat Completions 探针；只有目标模型、credential、授权和请求
协议共同可用才报告 `healthy`。因此 doctor 会产生一次真实的最小模型调用及相应费用。
