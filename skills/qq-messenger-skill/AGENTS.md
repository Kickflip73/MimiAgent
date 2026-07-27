# qq-messenger-skill

通过 CuaDriver 后台读取 QQ 可见上下文、总结或生成回复，并可靠发送消息，全程不弹窗不抢鼠标焦点。

## 触发词

发QQ消息、给XX发QQ、回复QQ、总结QQ消息、看看QQ里说了什么、根据上一句回复、send QQ message

## 使用

在对话中直接说：

```
给好乖乖发QQ消息说晚上吃什么
用QQ后台告诉张三明天开会
```

Agent 会调用 Skill 自带脚本一次完成：定位 QQ 进程 → 精确确认好友 → 后台输入消息 → 发送 → 前后对比验证。
发送结果不确定时脚本会停止且不会重试，避免重复消息。

需要理解上下文时，Agent 先读取一次当前可见聊天快照，再完成总结或生成回复；明确要求发送时才执行发送动作。

“回复某人的QQ消息”已经授权读取该联系人会话并发送合适的简短回复。不要先查 Mimi Session、Activity、Memory 或人物库，也不要因为用户没给回复正文就追问。

## 前置条件

- macOS 系统
- CuaDriver 已安装：`curl -fsSL https://cua.ai/driver/install.sh | bash`
- 已授权 Accessibility 和 Screen Recording：`cua-driver permissions grant`
- QQ 客户端已登录且在运行

## 安装

```bash
cp -r qq-messenger-skill ~/.agents/skills/qq-messenger-skill
```

## 文件

- `SKILL.md`：完整工作流和故障排查
- `scripts/send_qq.py`：可独立调用的 CLI 工具
