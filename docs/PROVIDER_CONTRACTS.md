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

`/models` 与 `model_control list` 只列出本地注册，不发起 Provider 请求。显式执行
`/model doctor [provider/model]` 时，OpenAI-compatible adapter 会向目标模型发送一个
输出上限为 1 token 的 Chat Completions 探针；只有目标模型、credential、授权和请求
协议共同可用才报告 `healthy`。因此 doctor 会产生一次真实的最小模型调用及相应费用。
