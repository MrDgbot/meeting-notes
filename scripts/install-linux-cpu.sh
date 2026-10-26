#!/usr/bin/env bash
# Linux 上没有 NVIDIA 显卡时用：按 uv.lock 的版本装依赖，只把 torch / torchaudio / torchcodec 换成 CPU 版
# （PyPI 上 Linux 的 torch 会带上 3GB 多的 CUDA 库，用 CPU 推理时用不上）。Dockerfile 和 CI 也用它。
# 用法：bash scripts/install-linux-cpu.sh [虚拟环境目录，默认 .venv]
# 装好以后用 UV_NO_SYNC=1 ./start.sh 启动：不加的话 uv run 会按 uv.lock 把 CUDA 版装回来。
set -euo pipefail
cd "$(dirname "$0")/.."
VENV="${1:-.venv}"
[ -x "$VENV/bin/python" ] || uv venv --python 3.11 "$VENV"
export VIRTUAL_ENV="$VENV"
REQ="$(mktemp)"
uv export --frozen --no-hashes --no-emit-project --no-header > "$REQ"
grep -v -E '^(torch==|torchaudio==|torchcodec==|triton==|nvidia-|cuda-)' "$REQ" > "$REQ.rest"
grep -E '^torch(audio|codec)?==' "$REQ" > "$REQ.torch"
uv pip install --no-deps -r "$REQ.rest"
uv pip install --no-deps -r "$REQ.torch" --index-url https://download.pytorch.org/whl/cpu
rm -f "$REQ" "$REQ.rest" "$REQ.torch"
"$VENV/bin/python" -c "import torch, torchaudio; print('torch', torch.__version__, 'torchaudio', torchaudio.__version__)"
