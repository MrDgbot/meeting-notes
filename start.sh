#!/usr/bin/env bash
# 启动会议记录服务：http://127.0.0.1:8770
set -euo pipefail
cd "$(dirname "$0")"
VENV="${VIRTUAL_ENV:-.venv}"
if [ -z "${UV_NO_SYNC:-}" ]; then
  if [ -f "$VENV/.no-uv-sync" ]; then
    export UV_NO_SYNC=1
  elif [ "$(uname -s)" = "Linux" ] && [ -x "$VENV/bin/python" ]; then
    if "$VENV/bin/python" -c "import torch, sys; sys.exit(0 if '+cpu' in torch.__version__ else 1)" 2>/dev/null; then
      export UV_NO_SYNC=1
    fi
  fi
fi
exec uv run uvicorn app:app --host 127.0.0.1 --port "${PORT:-8770}"
