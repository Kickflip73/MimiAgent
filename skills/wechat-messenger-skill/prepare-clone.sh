#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
clone_path=${MIMI_WECHAT_APP:-"/Users/liuyuran/Applications/微信-Mimi.app"}
state_dir=${MIMI_WECHAT_STATE_DIR:-"$HOME/.mimi-agent/wechat-bridge"}
token_file="$state_dir/token"
dylib_name="libMimiWeChatBridge.dylib"
dylib_path="$clone_path/Contents/Frameworks/$dylib_name"

if [ "$clone_path" = "/Applications/微信.app" ]; then
  printf '%s\n' "refusing to modify the official WeChat bundle" >&2
  exit 1
fi
if [ ! -d "$clone_path/Contents/Frameworks" ]; then
  printf '%s\n' "WeChat clone not found: $clone_path" >&2
  exit 1
fi

build_dir=$(sh "$root_dir/build-native.sh")
install -d -m 700 "$state_dir"
if [ ! -f "$token_file" ]; then
  umask 077
  openssl rand -hex 32 > "$token_file"
fi
chmod 600 "$token_file"
install -m 755 "$build_dir/$dylib_name" "$dylib_path"

environment_json=$(
  TOKEN_FILE="$token_file" DYLIB_PATH="$dylib_path" \
  /usr/bin/python3 -c 'import json, os; print(json.dumps({
    "DYLD_INSERT_LIBRARIES": os.environ["DYLIB_PATH"],
    "MIMI_WECHAT_BRIDGE_TOKEN_FILE": os.environ["TOKEN_FILE"],
  }))'
)
plutil -replace LSEnvironment -json "$environment_json" "$clone_path/Contents/Info.plist"

codesign --force --sign - "$dylib_path"
codesign --force --deep --sign - \
  --entitlements "$root_dir/native/entitlements.plist" \
  "$clone_path"

printf '%s\n' "$clone_path"
