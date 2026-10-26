"""端到端冒烟测试：起一个服务实例（临时数据目录、临时端口），上传一段普通话录音，按指定的识别模型各转写一次，核对文字。
可选再测全天模式：开启后用 --play 给的命令把录音放进“麦克风”（如 PulseAudio 的虚拟声卡），核对自动记录出来的文字。
不碰真实数据。CI（.github/workflows/ci.yml）和 Docker 验证都用它。

用法：
  .venv/bin/python tests/smoke_e2e.py                                   # paraformer + nano，录音用模型自带的示例
  .venv/bin/python tests/smoke_e2e.py --modes paraformer --url http://127.0.0.1:8780   # 测已经在跑的服务（如容器）
  .venv/bin/python tests/smoke_e2e.py --modes paraformer --ambient-play "paplay -d mn {wav}"
录音默认用 Paraformer 模型目录里的 example/asr_example.wav（“欢迎大家来到魔搭社区进行体验”）。
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPECT = "欢迎大家"


def find_sample() -> Path:
    base = Path(os.environ.get("MODELSCOPE_CACHE") or Path.home() / ".cache" / "modelscope")
    hits = sorted(base.glob("**/*seaco_paraformer_large*/**/example/asr_example.wav"))
    if not hits:
        sys.exit(f"在 {base} 里找不到 asr_example.wav：先跑一次服务把模型下载下来，或用 --wav 指定录音")
    return hits[0]


class Api:
    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def __call__(self, path, body=None, method=None, ctype="application/json", timeout=30):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=body, method=method or ("POST" if body is not None else "GET"),
                                     headers={"Content-Type": ctype})
        return json.load(urllib.request.urlopen(req, timeout=timeout))


def start_server(timeout: float) -> tuple[subprocess.Popen, str, Path]:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    data = Path(tempfile.mkdtemp(prefix="mn-smoke-"))
    log = open(data / "server.log", "ab")
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)], cwd=ROOT,
                            env={**os.environ, "MEETING_DATA": str(data), "PORT": str(port)}, stdout=log, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    wait_ready(Api(url), timeout, proc, data)
    return proc, url, data


def wait_ready(api: Api, timeout: float, proc=None, data=None):
    t = time.time()
    while time.time() - t < timeout:
        try:
            h = api("/api/health", timeout=3)
            if h["asr_ready"]:
                print(f"服务就绪（{time.time() - t:.0f} 秒，设备 {h['device']}）")
                return
            if h["asr_error"] and not h["asr_loading"]:
                raise SystemExit("语音模型加载失败：" + h["asr_error"])
        except OSError:
            pass
        if proc and proc.poll() is not None:
            raise SystemExit(f"服务没起来，日志：{data / 'server.log'}\n" + (data / "server.log").read_text("utf-8", "replace")[-3000:])
        time.sleep(1)
    raise SystemExit(f"语音模型 {timeout:.0f} 秒内没加载好")


def wait_meeting(api: Api, mid: str, timeout: float = 600) -> dict:
    t = time.time()
    while time.time() - t < timeout:
        r = api(f"/api/meetings/{mid}")
        if r["meta"]["status"] in ("ready", "error"):
            return r
        time.sleep(1)
    raise SystemExit(f"{mid} 在 {timeout:.0f} 秒内没转写完")


def text_of(r: dict) -> str:
    return "".join(p["text"] for p in (r.get("transcript") or {}).get("paragraphs", []))


def upload(api: Api, wav: Path, mode: str) -> bool:
    got = api("/api/asr", {"model": mode}, "PUT")["model"]
    if got != mode:
        print(f"FAIL  切换识别模型 {mode} → {got}")
        return False
    for _ in range(600):  # 切到 Nano 时后台加载，等它加载完再传
        a = api("/api/asr")
        if not a["nano_loading"]:
            break
        time.sleep(1)
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{wav.name}"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
            + wav.read_bytes() + f"\r\n--{b}--\r\n".encode())
    t = time.time()
    m = api("/api/meetings/upload", body, "POST", f"multipart/form-data; boundary={b}", timeout=120)
    r = wait_meeting(api, m["id"])
    text, eng = text_of(r), ((r.get("transcript") or {}).get("asr") or {}).get("engine")
    ok = r["meta"]["status"] == "ready" and EXPECT in text and eng == mode
    print(f"{'ok  ' if ok else 'FAIL'}  上传转写 [{mode}] 引擎 {eng}，{time.time() - t:.1f} 秒：{text or r['meta'].get('error')}")
    return ok


def ambient(api: Api, wav: Path, play: str, device: str) -> bool:
    api("/api/ambient/config", {"device": device, "min_speech_s": 0, "keep_awake": False}, "PUT")
    print("采音设备：", api("/api/ambient/devices")["devices"])
    st = api("/api/ambient", {"action": "start"})
    t = time.time()
    while st["state"] not in ("listening", "speech"):
        if time.time() - t > 120:
            print(f"FAIL  全天模式没开始收音：{st['state']} {st['error']}")
            api("/api/ambient", {"action": "stop"})
            return False
        time.sleep(1)
        st = api("/api/ambient")
    print(f"全天模式在收音（{st['state']}，音量 {st['level_db']} dB）")
    cmd = [a.replace("{wav}", str(wav)) for a in shlex.split(play)]
    for _ in range(2):
        subprocess.run(cmd, check=True)
        time.sleep(2)
    t = time.time()
    while True:  # 等最后一句识别完
        st = api("/api/ambient")
        if st["conv"] and st["state"] == "listening" and (st["last"] or time.time() - t > 60):
            break
        if time.time() - t > 120:
            break
        time.sleep(1)
    conv = st["conv"]
    if not conv:
        print(f"FAIL  放了录音，全天模式没有记录下对话：{st['state']} {st['error']}")
        api("/api/ambient", {"action": "stop"})
        return False
    live = "".join(p["text"] for p in api(f"/api/meetings/{conv['id']}")["live"])
    print(f"{'ok  ' if EXPECT in live else 'FAIL'}  全天模式实时文字（发言 {conv['speech_s']} 秒）：{live}")
    api("/api/ambient", {"action": "split"})  # 结束这段对话 → 排队精准转写
    r = wait_meeting(api, conv["id"])
    api("/api/ambient", {"action": "stop"})
    text = text_of(r)
    ok = EXPECT in live and r["meta"]["status"] == "ready" and EXPECT in text
    print(f"{'ok  ' if ok else 'FAIL'}  全天模式精准转写：{text or r['meta'].get('error')}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="测已经在跑的服务；不给就自己起一个（临时数据目录）")
    ap.add_argument("--modes", default="paraformer,nano")
    ap.add_argument("--wav", type=Path)
    ap.add_argument("--ambient-play", help="把录音放进麦克风的命令，{wav} 换成录音路径；不给就不测全天模式")
    ap.add_argument("--ambient-device", default="", help="全天模式用的采音设备，空 = 系统默认")
    ap.add_argument("--timeout", type=float, default=900, help="等语音模型加载的秒数（第一次要下载模型）")
    a = ap.parse_args()
    wav = a.wav or find_sample()
    proc = data = None
    if a.url:
        url = a.url
        wait_ready(Api(url), a.timeout)
    else:
        proc, url, data = start_server(a.timeout)
    api = Api(url)
    ok = True
    try:
        for m in [m for m in a.modes.split(",") if m]:
            ok &= upload(api, wav, m)
        if a.ambient_play:
            ok &= ambient(api, wav, a.ambient_play, a.ambient_device)
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()
            if not ok:
                print((data / "server.log").read_text("utf-8", "replace")[-4000:])
    print("全部通过" if ok else "有失败")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
