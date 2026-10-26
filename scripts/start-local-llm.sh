#!/usr/bin/env bash
# 可选：启动本地 Qwen3.8-Flash-Next（llama-server，端口 8090），用于完全离线生成纪要。
# 常驻内存约 38GB；生成约 16~25 token/s，1 小时会议的纪要约 2~3 分钟。
set -euo pipefail
SCRIPT="$HOME/models/Qwen3.8-Flash-Next-GSQ-RCO/start-server.sh"
[ -x "$SCRIPT" ] || { echo "找不到 $SCRIPT"; exit 1; }
PORT="${PORT:-8090}" CTX="${CTX:-32768}" exec "$SCRIPT"
