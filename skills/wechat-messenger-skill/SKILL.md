---
name: wechat-messenger-skill
description: 通过重签微信副本内的本地桥接器，在不激活微信、不抢鼠标键盘的前提下定位个人微信会话、输入并发送一条消息。仅用于 owner 已明确授权的个人账号和精确联系人。
---

# 微信后台消息

微信 4.x 的聊天界面是自绘控件，外部 CUA 后台像素事件可能被丢弃。不要升级成前台操作。
本 Skill 使用注入已授权重签副本的极小本地桥接器，让微信在自己的主线程内处理 UI，
同时在每个动作前后验证 `NSApp.active=false`。

## 硬边界

- 禁止对官方签名的 `/Applications/微信.app` 注入或直接改写。
- 仅使用 owner 已批准的重签副本，默认路径为
  `/Users/liuyuran/Applications/微信-Mimi.app`。
- 桥接器只允许本机 CFMessagePort，并要求至少 32 字符随机令牌。
- 微信处于前台时立即返回 `target_in_use`。
- 任一动作导致微信激活时返回 `foreground_violation`，停止且不重试。
- 每个 click/type/key 都会在动作前后做一次 `status` 往返校验，并由本机文件锁串行化，
  避免两个后台任务交错操作副本。
- 发送动作只执行一次；发送后必须通过新气泡和输入区清空双重验证。
- 当前桥接器仍只提供 status 和低层 UI 动作，尚未提供消息快照/稳定消息 ID；未完成真实副本
  验证及只读 snapshot 前，不得宣称支持持续监听或完整收发。

## 构建

```bash
<root>/build-native.sh
```

构建产物位于 Skill 的 `build/`，属于本机产物，不应提交到仓库。

把桥接器安装到已获授权的重签副本：

```bash
<root>/prepare-clone.sh
```

该命令拒绝修改官方 `/Applications/微信.app`，令牌写入 owner 私有的 `0600` 文件。
准备后通过 `open -g` 启动副本；启动前必须先确认官方微信已正常退出，不能并行抢占账号。

只读检查：

```bash
python3 <root>/scripts/bridge_call.py --action status
```
