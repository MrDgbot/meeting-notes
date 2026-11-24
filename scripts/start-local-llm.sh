#!/usr/bin/env bash
# 可选：启动本地大模型（llama-server，默认端口 8090），用于完全离线生成纪要。
# 常驻内存约 38GB；生成约 16~25 token/s，1 小时会议的纪要约 2~3 分钟。
# 可通过环境变量覆盖默认路径：
#   LOCAL_LLM_SCRIPT=/path/to/start-server.sh ./scripts/start-local-llm.sh
#   LOCAL_LLM_CMD="llama-server -m /path/to/model.gguf --port 8090 --ctx-size 32768" ./scripts/start-local-llm.sh
set -euo pipefail
export PORT="${PORT:-8090}"
export CTX="${CTX:-32768}"
if [ -n "${LOCAL_LLM_CMD:-}" ]; then
  exec bash -c "$LOCAL_LLM_CMD"
fi
SCRIPT="${LOCAL_LLM_SCRIPT:-$HOME/models/Qwen3.8-Flash-Next-GSQ-RCO/start-server.sh}"
if [ ! -x "$SCRIPT" ]; then
  echo "找不到可执行的本地模型启动脚本：$SCRIPT" >&2
  echo "请设置环境变量 LOCAL_LLM_SCRIPT（指向启动脚本）或 LOCAL_LLM_CMD（完整启动命令）。" >&2
  exit 1
fi
exec "$SCRIPT"
