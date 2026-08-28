# 每日 AI 趋势 · 2026-08-13 讲解稿

大家好，这里是今天的 AI 趋势简报，覆盖最近三十天，也就是七月中旬到八月中旬。

先说五个最值得关注的核心判断。

第一，Skills 正在成为跨厂商 Agent 开发的通用抽象层。Anthropic 官方的 skills 仓库已经有十六万八千多颗星，obra 的 superpowers 更是达到二十七万颗星，mattpocock 的 skills 也有二十一万六千多颗星。Skills 从单一厂商的特性，变成了 Claude Code、Codex、Cursor 和 Opencode 通用的开发范式。

第二，开源编码 Agent 从「能写代码」进入了「自举和自维护」的阶段。opencode 接近二十万颗星，Google 的 gemini-cli 超过十万颗星，而 claw-code 这个项目明确标注是零人工干预、由 Agent 自己持续维护的，这是一个标志性信号。

第三，Agent 运行时和记忆，成了性能优化的新战场。ECC 这个项目有将近二十四万颗星，它把 Skills、本能、记忆、安全和研究优先打包成一个 harness 优化层。Nous Research 的 hermes-agent 主打「与你一起成长的 Agent」，记忆成了核心卖点。

第四，业务软件开始被 Agent-first 重构。新出现的 trycompai 是一个专为 AI Agent 设计的 CRM，genoffice 是开源 AI 办公套件，还有 YC 背景的多人 Agent 协同工具 qm。CRM、办公、协同，都在以 Agent 为第一用户重新搭建。

第五，模型默认值和协议层在加速迭代。OpenAI 的 Agents SDK 在八月十一号发布了 v0.20，把默认模型切到了 GPT-5.6 Luna，并同时支持 MCP 的 v1 和 v2 两个版本。

下面是十二条重点进展。

第一，OpenAI Agents SDK v0.20 发布。默认模型更新为 GPT-5.6 Luna，同时兼容 MCP v1 和 v2，这意味着依赖它的开发者会随升级自动切到新默认模型，Agent 的协议层也进入新一轮标准化。

第二，Anthropic 官方的 Agent Skills 仓库累计超过十六万八千颗星，Skills 已经从实验特性沉淀为社区广泛采用的标准抽象。

第三，obra 的 superpowers 以二十七万颗星登顶同类仓库，它把 Skills 框架和一整套软件开发方法论打包，反映 Agent 开发从拼提示词转向拼可复用能力。

第四，ECC 提出 Agent harness 性能优化，把 Skills、记忆、安全等组合成针对多个编码 Agent 的优化层，标志着 Agent 工程从模型层转向运行时调优。

第五，Nous Research 的 hermes-agent 以「成长型 Agent」为卖点，把长期记忆和自我演化作为核心能力。

第六，开源编码 Agent 密集活跃，opencode、gemini-cli、pi 三个项目在近三十天都保持高频推送，本地和终端的编码 Agent 选择越来越多。

第七，claw-code 是一个零人工干预、由 Agent 自行维护的 Rust 项目，是 Agent 自举的标志性案例。

第八，Agent-first 的业务软件出现，trycompai 的 CRM 和 genoffice 的办公套件几乎同时出现，传统 SaaS 品类开始以 Agent 为第一用户重构。

第九，YC 背景的 qm 项目定位多人 Agent 协同 harness，是近三十天新仓库中星标增长最快的之一。

第十，mem0 作为 AI Agent 的通用记忆层持续迭代，记忆不再各自造轮子，而成为可插拔的通用组件。

第十一，浏览器和手机自动化 Agent 持续升温，browser-use 保持十万颗星以上，新的 phone-harness 把 Agent 的控制对象延伸到手机。

第十二，QwenAudio 推出实时语音 Agent 运行时，补充了开源侧的实时语音能力。

最后说明一下数据来源。本次运行因为网络限制，Reddit、X、YouTube 等社区平台无法采集，社区热度暂以 GitHub 星标量作为代理。所有星标数、日期和发布说明都来自 GitHub 官方 API，属于一手可验证的数据。模型厂商官方博客的具体公告本次未能直接抓取，相关判断以 GitHub 发布说明为准。

以上是今天的 AI 趋势简报，感谢收听。
