# 在 Linux 容器里运行会议记录（CPU 推理，linux/amd64 和 linux/arm64 都能构建）。用法见 docs/guide.md 的“Docker”一节。
#   docker build -t meeting-notes .
#   docker run --rm -p 127.0.0.1:8770:8770 -e MN_LOCAL_CLIENTS=172.17.0.1 \
#     -v ~/.cache/modelscope:/models:ro -v ~/meeting-data:/data meeting-notes
FROM python:3.11-slim-trixie
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv
# ffmpeg：解码、转码、全天模式采音（-f pulse / -f alsa）；pulseaudio-utils：paplay / pactl，排查 PulseAudio 连接用
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH
# 版本和 uv.lock 完全一致，只把 torch / torchaudio / torchcodec 换成 CPU 版
COPY pyproject.toml uv.lock ./
COPY scripts/install-linux-cpu.sh scripts/
RUN --mount=type=cache,target=/root/.cache/uv bash scripts/install-linux-cpu.sh /opt/venv
COPY *.py ./
COPY static ./static
COPY scripts ./scripts
# 数据放 /data，模型缓存放 /models（建议挂载宿主机的 ~/.cache/modelscope，免得每次重新下载约 4GB 模型；只读也可以）
ENV MEETING_DATA=/data MODELSCOPE_CACHE=/models PORT=8770
EXPOSE 8770
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
