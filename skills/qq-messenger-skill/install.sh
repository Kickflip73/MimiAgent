#!/bin/sh
# install.sh — 安装 qq-messenger-skill 到当前平台的 Agent Skills 目录
set -eu

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_NAME="qq-messenger-skill"

info()  { echo "[INFO]  $1"; }
done_msg() { echo "[OK]    $1"; }

# MimiAgent / Universal
if [ -d "$HOME/.agents" ]; then
    cp -R "$SKILL_DIR" "$HOME/.agents/skills/$SKILL_NAME"
    done_msg "已安装到 ~/.agents/skills/$SKILL_NAME"
elif [ -d "$HOME/Project/MimiAgent/skills" ]; then
    # 已在该目录中，直接 reload
    done_msg "已在 MimiAgent skills 目录中，调用 reload_skills 即可"
else
    info "未检测到支持的 Agent，手动复制到你的 skills 目录即可"
fi
