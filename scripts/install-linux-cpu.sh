#!/usr/bin/env bash
# Linux 上没有 NVIDIA 显卡时用：按 uv.lock 的版本装依赖，只把 torch / torchaudio / torchcodec 换成 CPU 版
# （PyPI 上 Linux 的 torch 会带上 3GB 多的 CUDA 库，用 CPU 推理时用不上）。Dockerfile 和 CI 也用它。
# 用法：bash scripts/install-linux-cpu.sh [虚拟环境目录，默认 .venv]
# 装好后会在虚拟环境里写入 .no-uv-sync 标记，./start.sh 会自动跳过 uv sync，不会把 CUDA 版装回来。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" ]; then
  case "$1" in
    /*) VENV="$1" ;;
    *)  VENV="$(pwd)/$1" ;;
  esac
else
  VENV="$ROOT/.venv"
fi
cd "$ROOT"
[ -x "$VENV/bin/python" ] || uv venv --python 3.11 "$VENV"
export VIRTUAL_ENV="$VENV"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
REQ="$TMP_DIR/req.txt"
uv export --frozen --no-hashes --no-emit-project --no-header > "$REQ"
grep -v -E '^(torch==|torchaudio==|torchcodec==|triton==|nvidia-|cuda-)' "$REQ" > "$TMP_DIR/rest.txt"
grep -E '^torch(audio|codec)?==' "$REQ" > "$TMP_DIR/torch.txt"
uv pip install --no-deps -r "$TMP_DIR/rest.txt"
uv pip install --no-deps -r "$TMP_DIR/torch.txt" --index-url https://download.pytorch.org/whl/cpu
touch "$VENV/.no-uv-sync"
"$VENV/bin/python" -c "import torch, torchaudio; print('torch', torch.__version__, 'torchaudio', torchaudio.__version__)"
