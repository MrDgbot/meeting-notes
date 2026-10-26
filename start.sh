#!/usr/bin/env bash
# 启动会议记录服务：http://127.0.0.1:8770
cd "$(dirname "$0")"
exec uv run uvicorn app:app --host 127.0.0.1 --port "${PORT:-8770}"
