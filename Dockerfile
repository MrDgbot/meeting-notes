# 在 Linux 容器里运行会议记录（CPU 推理，linux/amd64 和 linux/arm64 都能构建）。用法见 docs/guide.md 的“Docker”一节。
#   docker build -t meeting-notes .
#   docker run --rm -p 127.0.0.1:8770:8770 -e MN_LOCAL_CLIENTS=172.17.0.1 \
#     -v ~/.cache/modelscope:/models:ro -v ~/meeting-data:/data meeting-notes
FROM python:3.11-slim-trixie AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_PREFERENCE=only-system UV_PYTHON_DOWNLOADS=never VIRTUAL_ENV=/opt/venv
# 版本和 uv.lock 完全一致，只把 torch / torchaudio / torchcodec 换成 CPU 版
COPY pyproject.toml uv.lock ./
COPY scripts/install-linux-cpu.sh scripts/
RUN --mount=type=cache,target=/root/.cache/uv bash scripts/install-linux-cpu.sh /opt/venv

FROM python:3.11-slim-trixie
# ffmpeg：解码、转码、全天模式采音；pulseaudio-utils：paplay / pactl；iproute2：lan.addresses()；tini：PID 1 回收子进程
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg pulseaudio-utils iproute2 tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -s /bin/sh app \
    && mkdir -p /app /data /models \
    && chown -R app:app /app /data /models
WORKDIR /app
COPY --from=builder --chown=app:app /opt/venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
COPY --chown=app:app *.py ./
COPY --chown=app:app static ./static
COPY --chown=app:app scripts ./scripts
# 数据放 /data，模型缓存放 /models（建议挂载宿主机的 ~/.cache/modelscope，免得每次重新下载约 4GB 模型；只读也可以）
ENV MEETING_DATA=/data MODELSCOPE_CACHE=/models PORT=8770
USER app
EXPOSE 8770 8771
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8770\")}/api/health', timeout=3)" || exit 1
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port \"${PORT}\""]
