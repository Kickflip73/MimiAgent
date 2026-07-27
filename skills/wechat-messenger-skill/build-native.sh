#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir=${MIMI_WECHAT_BRIDGE_BUILD_DIR:-"$root_dir/build"}
mkdir -p "$output_dir"

clang -fobjc-arc -dynamiclib \
  -framework AppKit \
  -framework CoreFoundation \
  -framework Foundation \
  -o "$output_dir/libMimiWeChatBridge.dylib" \
  "$root_dir/native/MimiWeChatBridge.m"

swiftc \
  -o "$output_dir/mimi-wechat-bridge-client" \
  "$root_dir/native/mimi-wechat-bridge-client.swift"

chmod 700 "$output_dir/mimi-wechat-bridge-client"
codesign --force --sign - "$output_dir/libMimiWeChatBridge.dylib"
codesign --force --sign - "$output_dir/mimi-wechat-bridge-client"

printf '%s\n' "$output_dir"
