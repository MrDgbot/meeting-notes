"""录音续接的集成测试：起一个独立的服务实例（临时数据目录、临时端口），用脚本模拟手机网页。

覆盖：断网后补发（不丢不重）、半开连接（旧连接没察觉断了就重连）、另一个页面抢录、断线后换人续录、
服务被杀掉重启后接回同一次录音、等不到重连时自动收尾、已结束的录音再重连。
每个用例最后都按字节核对 audio.pcm：内容必须正好是网页产生的那串块，顺序一致。

用法：.venv/bin/python tests/test_live_resume.py     （约 1–2 分钟，大部分时间在加载语音模型）
"""
import asyncio
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 3200
GRACE = 4  # 测试里把“等重连”缩到 4 秒


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, data: Path):
        self.data, self.port, self.proc = data, free_port(), None

    def start(self):
        env = {**os.environ, "MEETING_DATA": str(self.data), "PORT": str(self.port), "LIVE_GRACE_S": str(GRACE)}
        self.log = open(self.data / "server.log", "ab")
        self.proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(self.port)],
                                     cwd=ROOT, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(300):
            try:
                if json.load(urllib.request.urlopen(f"{self.url}/api/health", timeout=2))["asr_ready"]:
                    return
            except Exception:  # noqa: BLE001
                pass
            if self.proc.poll() is not None:
                raise RuntimeError("服务没起来，见 " + str(self.data / "server.log"))
            time.sleep(0.5)
        raise RuntimeError("语音模型 150 秒内没加载好")

    def kill(self):
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait()

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.kill()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def ws(self, mid, rec):
        return f"ws://127.0.0.1:{self.port}/ws/live/{mid}?rec={rec}"

    def api(self, path, body=None, method=None):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                                     method=method or ("POST" if body is not None else "GET"), headers={"Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=10))


def chunk(i: int) -> bytes:
    """第 i 块：开头写上块号，后面是很小的固定值（模型当静音处理），用来核对顺序。"""
    return struct.pack("<I", i) + bytes([i % 7]) * (CHUNK - 4)


def check_pcm(srv: Server, mid: str, start: int, n: int) -> None:
    raw = (srv.data / "meetings" / mid / "audio.pcm").read_bytes()
    assert len(raw) == start + n * CHUNK, f"pcm 应为 {start + n * CHUNK} 字节，实际 {len(raw)}"
    for i in range(n):
        got = raw[start + i * CHUNK: start + (i + 1) * CHUNK]
        assert got == chunk(i), f"第 {i} 块不对（块号 {struct.unpack('<I', got[:4])[0]}）"


async def ready(ws) -> dict:
    while True:
        j = json.loads(await asyncio.wait_for(ws.recv(), 20))
        if j["type"] in ("ready", "error", "stopped"):
            return j


async def send_range(ws, a, b):
    for i in range(a, b):
        await ws.send(chunk(i))


async def stop(ws, produced) -> dict:
    await ws.send(json.dumps({"type": "stop", "produced": produced, "dropped": 0}))
    while True:
        j = json.loads(await asyncio.wait_for(ws.recv(), 30))
        if j["type"] == "stopped":
            return j


async def wait_received(ws, n_bytes, timeout=10):
    """等服务端确认收到 n 字节（发一条 stat，服务端回 ack）。"""
    t = time.time()
    while time.time() - t < timeout:
        await ws.send(json.dumps({"type": "stat", "produced": n_bytes, "dropped": 0}))
        try:
            while True:
                j = json.loads(await asyncio.wait_for(ws.recv(), 1))
                if j["type"] == "ack" and j["bytes"] >= n_bytes:
                    return j
        except TimeoutError:
            pass
    raise AssertionError(f"服务端 {timeout} 秒内没确认收到 {n_bytes} 字节")


def meeting(srv, title):
    return srv.api("/api/meetings", {"title": title})["id"]


def health(srv, mid, rec):
    return next(x for x in srv.api(f"/api/meetings/{mid}")["meta"]["rec_health"] if x["rec"] == rec)


# ---------------- 用例 ----------------
async def t_drop_and_resend(srv):
    """断网：服务端收到一部分就断了（不发关闭帧），网页继续攒着，重连后从服务端说的位置补发。"""
    mid, rec = meeting(srv, "断网补发"), "rec-drop"
    ws = await websockets.connect(srv.ws(mid, rec), max_size=None)
    r = await ready(ws)
    assert r["type"] == "ready" and r["file_bytes"] == 0 and not r["resumed"], r
    await send_range(ws, 0, 30)
    await wait_received(ws, 30 * CHUNK)
    ws.transport.abort()  # 网络断了：TCP 直接没了
    await asyncio.sleep(0.5)
    st = srv.api(f"/api/meetings/{mid}")
    assert st["live_state"]["state"] == "reconnecting", st["live_state"]
    # 断开期间网页又录了 20 块（攒在本地）
    ws = await websockets.connect(srv.ws(mid, rec), max_size=None)
    r = await ready(ws)
    assert r["type"] == "ready" and r["resumed"], r
    k = (r["file_bytes"] - r["start_bytes"]) // CHUNK
    assert k == 30, f"服务端说收到了 {k} 块，应为 30"
    await send_range(ws, k, 50)
    j = await stop(ws, 50 * CHUNK)
    assert j["file_bytes"] == 50 * CHUNK, j
    await ws.close()
    check_pcm(srv, mid, 0, 50)
    h = health(srv, mid, rec)
    assert h["reconnects"] == 1 and h["received"] == 50 * CHUNK and h["end"] == "stop", h
    return "50 块，断开 1 次，补发 20 块，pcm 逐块一致"


async def t_half_open(srv):
    """旧连接没察觉断了（手机换了网络）就用同一个编号重连：旧连接之后送到的数据必须丢掉，不能重复写。"""
    mid, rec = meeting(srv, "半开连接"), "rec-half"
    a = await websockets.connect(srv.ws(mid, rec), max_size=None)
    await ready(a)
    await send_range(a, 0, 20)
    await wait_received(a, 20 * CHUNK)
    b = await websockets.connect(srv.ws(mid, rec), max_size=None)
    r = await ready(b)
    k = (r["file_bytes"] - r["start_bytes"]) // CHUNK
    assert r["resumed"] and k == 20, r
    try:  # 旧连接上又冒出来的数据（网页那边其实已经切到新连接重发了）
        await send_range(a, 20, 25)
    except websockets.ConnectionClosed:
        pass
    await send_range(b, 20, 40)
    await stop(b, 40 * CHUNK)
    await b.close()
    check_pcm(srv, mid, 0, 40)
    return "旧连接后来送到的 5 块被丢弃，pcm 无重复"


async def t_busy(srv):
    """同一个会议，另一个页面（别的编号）在录：拒绝。"""
    mid = meeting(srv, "抢录")
    a = await websockets.connect(srv.ws(mid, "rec-a"), max_size=None)
    await ready(a)
    b = await websockets.connect(srv.ws(mid, "rec-b"), max_size=None)
    r = await ready(b)
    assert r["type"] == "error" and r["code"] == "busy", r
    await stop(a, 0)
    await a.close()
    return "第二个页面收到 busy"


async def t_takeover(srv):
    """录音的页面断线后没回来（比如页面被刷新了），换一个页面续录：旧的收尾、新的接在后面，不转写旧的。"""
    mid = meeting(srv, "换人续录")
    a = await websockets.connect(srv.ws(mid, "rec-old"), max_size=None)
    await ready(a)
    await send_range(a, 0, 10)
    await wait_received(a, 10 * CHUNK)
    a.transport.abort()
    await asyncio.sleep(0.5)
    b = await websockets.connect(srv.ws(mid, "rec-new"), max_size=None)
    r = await ready(b)
    assert r["type"] == "ready" and not r["resumed"] and r["start_bytes"] == 10 * CHUNK, r
    for i in range(10):  # 新录音的块号从 0 开始，接在旧的 10 块后面
        await b.send(chunk(i))
    await stop(b, 10 * CHUNK)
    await b.close()
    raw = (srv.data / "meetings" / mid / "audio.pcm").read_bytes()
    assert len(raw) == 20 * CHUNK and raw[:CHUNK] == chunk(0) and raw[10 * CHUNK:11 * CHUNK] == chunk(0), len(raw)
    assert health(srv, mid, "rec-old")["end"] == "takeover"
    return "旧录音 takeover 收尾，新录音从第 10 块位置接上"


async def t_expire(srv):
    """断开超过等待时间：自动收尾并转写；之后同一个编号再连回来，告诉网页已经结束、落盘到哪里。"""
    mid, rec = meeting(srv, "等不到重连"), "rec-exp"
    ws = await websockets.connect(srv.ws(mid, rec), max_size=None)
    await ready(ws)
    await send_range(ws, 0, 15)
    await wait_received(ws, 15 * CHUNK)
    await ws.send(json.dumps({"type": "gap", "at_ms": 1200, "dur_ms": 8000, "reason": "hidden"}))
    await ws.send(json.dumps({"type": "stat", "produced": 25 * CHUNK, "dropped": 0}))
    await asyncio.sleep(0.3)
    ws.transport.abort()
    await asyncio.sleep(GRACE + 1.5)
    m = srv.api(f"/api/meetings/{mid}")
    h = health(srv, mid, rec)
    assert h["end"] == "timeout" and m["meta"]["status"] in ("queued", "transcribing", "ready", "new"), (h, m["meta"]["status"])
    assert h["gaps"] == [{"at_ms": 1200, "dur_ms": 8000, "reason": "hidden"}], h["gaps"]
    assert not m["live_active"]
    ws = await websockets.connect(srv.ws(mid, rec), max_size=None)
    r = await ready(ws)
    assert r["type"] == "stopped" and r["already"] and r["file_bytes"] == 15 * CHUNK, r
    await ws.close()
    return f"{GRACE} 秒后自动收尾（状态 {m['meta']['status']}），缺口记录在案，再连回来收到 already"


async def t_restart(srv):
    """录到一半服务进程被杀掉：重启后不急着转写，等网页带同一个编号连回来接着录。"""
    mid, rec = meeting(srv, "服务重启"), "rec-restart"
    ws = await websockets.connect(srv.ws(mid, rec), max_size=None)
    await ready(ws)
    await send_range(ws, 0, 25)
    await wait_received(ws, 25 * CHUNK)
    srv.kill()
    # 模拟进程死在写一半：pcm 末尾多出半块
    with open(srv.data / "meetings" / mid / "audio.pcm", "ab") as f:
        f.write(b"\x01" * 1000)
    srv.start()
    m = srv.api(f"/api/meetings/{mid}")
    assert m["live_active"] and m["live_state"]["state"] == "reconnecting" and m["meta"]["status"] == "recording", m["meta"]["status"]
    ws = await websockets.connect(srv.ws(mid, rec), max_size=None)
    r = await ready(ws)
    k = (r["file_bytes"] - r["start_bytes"]) // CHUNK
    assert r["resumed"] and k == 25 and (r["file_bytes"] - r["start_bytes"]) % CHUNK == 0, r
    await send_range(ws, k, 40)
    await stop(ws, 40 * CHUNK)
    await ws.close()
    check_pcm(srv, mid, 0, 40)
    h = health(srv, mid, rec)
    assert h.get("restarts") == 1 and h["end"] == "stop", h
    return "重启后截掉半块，从第 25 块续上，pcm 逐块一致"


async def main():
    tmp = Path(tempfile.mkdtemp(prefix="mn-live-"))
    (tmp / "meetings").mkdir()
    for name in ("settings.json", "vocab.json"):
        if (ROOT / "data" / name).exists():
            shutil.copy(ROOT / "data" / name, tmp / name)
    srv = Server(tmp)
    fails = 0
    try:
        srv.start()
        for t in (t_drop_and_resend, t_half_open, t_busy, t_takeover, t_expire, t_restart):
            try:
                msg = await t(srv)
                print(f"通过  {t.__doc__.strip().splitlines()[0]}\n      → {msg}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                print(f"失败  {t.__doc__.strip().splitlines()[0]}\n      → {type(e).__name__}: {e}")
    finally:
        srv.stop()
    print(f"\n{'全部通过' if not fails else f'{fails} 项失败'}（日志：{tmp / 'server.log'}）")
    if not fails:
        shutil.rmtree(tmp, ignore_errors=True)
    return fails


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
