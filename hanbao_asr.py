"""憨包云端识别（实验性）。asr.AsrRequest protobuf over WSS，音频为 16k 单声道 Opus 20ms 帧。

这是非公开接口，可能随时失效；调用方应在失败/无结果时回退本地模型。
服务地址、应用标识、设备参数都不写在代码里，放在本机配置 data/hanbao.json（或环境变量 HANBAO_CONFIG 指向的文件），
字段见 config()。没有配置时设置里不出现这个选项。用之前自己确认有权这样调用、符合对方的服务条款；录音会上传到对方服务器。
"""
import asyncio
import ctypes
import ctypes.util
import json
import logging
import os
import random
import threading
import time
import uuid
from pathlib import Path

import httpx
import numpy as np
import websockets

import store

log = logging.getLogger("hanbao")
OK = 20_000_000
FIRST, MIDDLE, LAST = 1, 3, 9
FRAME = 320  # 20ms @ 16k
DEVICE_FILE = store.DATA / "hanbao_device.json"
CONFIG_FILE = Path(os.environ.get("HANBAO_CONFIG") or store.DATA / "hanbao.json")
# ws_url、register_url：识别和设备注册的地址；user_agent、app_key；app、device：注册和连接时带的应用/设备参数
# （app 里要有 aid、app_name）；register_body：注册请求体里另外要带的字段（可选）
_NEED = ("ws_url", "register_url", "user_agent", "app_key", "app", "device")


class HanbaoError(Exception):
    pass


def config() -> dict | None:
    """本机配置；缺文件或缺字段返回 None（这个模式就不可用）。"""
    c = store.read_json(CONFIG_FILE)
    ok = isinstance(c, dict) and all(c.get(k) for k in _NEED) and all((c.get("app") or {}).get(k) for k in ("aid", "app_name"))
    return c if ok else None


def _cfg() -> dict:
    c = config()
    if not c:
        raise HanbaoError(f"没有配置（{CONFIG_FILE.name}）")
    return c


# ---------------- protobuf（极简） ----------------
def _uvarint(n: int) -> bytes:
    out = bytearray()
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


def _pb_bytes(field: int, b: bytes) -> bytes:
    return _uvarint(field << 3 | 2) + _uvarint(len(b)) + b


def _pb_varint(field: int, v: int) -> bytes:
    return _uvarint(field << 3) + _uvarint(v)


def _pb_parse(buf: bytes) -> dict:
    out, i = {}, 0

    def rv():
        nonlocal i
        v = shift = 0
        while True:
            b = buf[i]
            i += 1
            v |= (b & 0x7F) << shift
            if b < 0x80:
                return v
            shift += 7
    while i < len(buf):
        tag = rv()
        f, wt = tag >> 3, tag & 7
        if wt == 0:
            out.setdefault(f, rv())
        elif wt == 2:
            n = rv()
            out.setdefault(f, buf[i:i + n])
            i += n
        elif wt in (1, 5):
            i += 8 if wt == 1 else 4
        else:
            raise HanbaoError("protobuf 格式不支持")
    return out


def _request(token: str, method: str, payload: str, audio: bytes, rid: str, frame: int) -> bytes:
    b = _pb_bytes(2, token.encode()) if token else b""
    b += _pb_bytes(3, b"ASR") + _pb_bytes(5, method.encode())
    if payload:
        b += _pb_bytes(6, payload.encode())
    if audio:
        b += _pb_bytes(7, audio)
    b += _pb_bytes(8, rid.encode())
    if frame:
        b += _pb_varint(9, frame)
    return b


def _response(data: bytes) -> dict:
    f = _pb_parse(data)
    s = lambda k: f.get(k, b"").decode("utf-8", "replace") if isinstance(f.get(k), bytes) else ""  # noqa: E731
    status = f.get(5, 0)
    status = status - (1 << 64) if status >= 1 << 63 else status
    return {"event": s(4), "status": status, "message": s(6), "result": s(7)}


# ---------------- Opus ----------------
OPUS_VOIP, SET_BITRATE, SET_COMPLEXITY, GET_BITRATE = 2048, 4002, 4010, 4003
_opus = None


def _lib():
    """用到时才加载 libopus：没装 opus 的机器上 import 这个模块也不报错，只是这个模式用不了。"""
    global _opus
    if _opus is None:
        path = ctypes.util.find_library("opus") or "/opt/homebrew/lib/libopus.dylib"
        try:
            lib = ctypes.CDLL(path)
        except OSError as e:
            raise HanbaoError(f"找不到 libopus（macOS：brew install opus）：{e}") from e
        lib.opus_encoder_create.restype = ctypes.c_void_p
        lib.opus_encoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_char_p, ctypes.c_int32]
        lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
        # opus_encoder_ctl 是变参函数：只声明固定参数，多出来的参数 ctypes 在 Apple arm64 上按变参传
        lib.opus_encoder_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int]
        _opus = lib
    return _opus


class _Encoder:
    def __init__(self, bitrate: int = 16000, complexity: int = 5):
        _lib()
        err = ctypes.c_int()
        self.enc = _opus.opus_encoder_create(16000, 1, OPUS_VOIP, ctypes.byref(err))
        if not self.enc or err.value:
            raise HanbaoError("Opus 编码器创建失败")
        _opus.opus_encoder_ctl(self.enc, SET_BITRATE, ctypes.c_int32(bitrate))
        _opus.opus_encoder_ctl(self.enc, SET_COMPLEXITY, ctypes.c_int32(complexity))
        self.buf = ctypes.create_string_buffer(4000)

    def bitrate(self) -> int:
        v = ctypes.c_int32()
        _opus.opus_encoder_ctl(self.enc, GET_BITRATE, ctypes.byref(v))
        return v.value

    def encode(self, pcm: np.ndarray) -> bytes:
        pcm = np.ascontiguousarray(pcm, dtype=np.int16)
        n = _opus.opus_encode(self.enc, pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)), len(pcm), self.buf, 4000)
        if n <= 0:
            raise HanbaoError(f"Opus 编码失败 {n}")
        return self.buf.raw[:n]

    def __del__(self):
        if getattr(self, "enc", None):
            _opus.opus_encoder_destroy(self.enc)


def _frames(audio: np.ndarray) -> list[np.ndarray]:
    x = np.clip(np.asarray(audio, dtype=np.float32), -1, 1)
    pcm = (x * 32767).astype(np.int16)
    pad = (-len(pcm)) % FRAME
    if pad:
        pcm = np.concatenate([pcm, np.zeros(pad, dtype=np.int16)])
    return [pcm[i:i + FRAME] for i in range(0, len(pcm), FRAME)]


# ---------------- 设备注册 ----------------
_dev_lock = threading.Lock()


def _device_id() -> str:
    with _dev_lock:
        d = store.read_json(DEVICE_FILE) or {}
        if d.get("did"):
            return d["did"]
        c = _cfg()
        app, dev = list(c["app"].items()), list(c["device"].items())
        cdid, now = str(uuid.uuid4()), str(int(time.time() * 1000))
        header = dict(app + dev)
        header.update({"device_id": 0, "install_id": 0, "cdid": cdid, "openudid": f"{random.getrandbits(64):016x}",
                       "clientudid": str(uuid.uuid4()), "region": "CN", "tz_name": "Asia/Shanghai", "tz_offset": 28800,
                       "sim_region": "cn", "carrier_region": "cn", "cpu_abi": "arm64-v8a", "build_serial": "unknown",
                       "not_request_sender": 0, "sig_hash": "", "google_aid": "", "mc": "", "serial_number": ""})
        q = app + dev + [("ssmix", "a"), ("_rticket", now), ("cdid", cdid), ("ac", "wifi")]
        r = httpx.post(c["register_url"], params=q, timeout=10, headers={"User-Agent": c["user_agent"]},
                       json={**(c.get("register_body") or {}), "header": header, "_gen_time": int(now)})
        if r.status_code != 200:
            raise HanbaoError(f"憨包设备注册 HTTP {r.status_code}")
        j = r.json() if r.content else {}
        did = str(j.get("device_id_str") or j.get("device_id") or "")
        if not did or did == "0":
            raise HanbaoError("憨包设备注册被拒绝")
        store.write_json(DEVICE_FILE, {"did": did})
        log.info("hanbao device registered")
        return did


def _reset_device():
    with _dev_lock:
        DEVICE_FILE.unlink(missing_ok=True)


# ---------------- 识别 ----------------
class _Transcript:
    """上游按句定稿（index 递增，同一句可能再次定稿按 index 覆盖）。"""

    def __init__(self):
        self.sentences: dict[int, str] = {}
        self.current = ""
        self.next_index = 0
        self.raw: list = []
        self.progress = 0.0  # 服务端已处理到的音频位置（秒），取结果里最大的 end_time
        self.progress_at = time.monotonic()

    def text(self) -> str:
        parts = [self.sentences[k] for k in sorted(self.sentences)] or [self.current]
        out = ""
        for t in filter(None, parts):
            if out and not _cjk(out[-1]) and not _cjk(t[0]):
                out += " "
            out += t
        return out

    def update(self, payload: str):
        try:
            v = json.loads(payload)
        except ValueError:
            return
        self.raw.append(v)
        results = v.get("results") or []
        end = max([r.get("end_time") or 0 for r in results] or [0])
        if end > self.progress:
            self.progress, self.progress_at = end, time.monotonic()
        if not any("index" in r for r in results):
            t = (results[0].get("text") if results else "") or ""
            if t:
                self.sentences.clear()
                self.current = t
            return
        for r in results:
            t = r.get("text") or ""
            if not t:
                continue
            fin = (r.get("extra") or {}).get("nonstream_result") or (r.get("is_interim") is False and r.get("is_vad_finished") is True)
            if fin:
                idx = r.get("index", self.next_index)
                self.sentences[idx] = t
                self.next_index = max(self.next_index, idx + 1)
                self.current = ""
            else:
                self.current = t


def _cjk(c: str) -> bool:
    o = ord(c)
    return 0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF


async def _expect(ws, event: str):
    while True:
        r = _response(await asyncio.wait_for(ws.recv(), 10))
        if r["event"].endswith("Failed") or (r["event"] == event and r["status"] != OK):
            raise HanbaoError(f"憨包 {r['event']} {r['status']}: {r['message']}")
        if r["event"] == event:
            return


async def _session(audio: np.ndarray, speed: float, lead: float, rejection: bool, raw: bool) -> dict:
    c = _cfg()
    app_key, aid = c["app_key"], c["app"]["aid"]
    did = await asyncio.to_thread(_device_id)
    rid = str(uuid.uuid4())
    session = json.dumps({
        "audio_info": {"channel": 1, "format": "speech_opus", "sample_rate": 16000},
        "enable_punctuation": True,
        "enable_speech_rejection": rejection,
        "extra": {"app_name": c["app"]["app_name"], "cell_compress_rate": 8, "did": did, "enable_asr_threepass": False,
                  "enable_asr_twopass": True, "input_mode": "stream"},
    })
    tr = _Transcript()
    async with websockets.connect(f"{c['ws_url']}?aid={aid}&device_id={did}", user_agent_header=c["user_agent"], open_timeout=10,
                                  additional_headers={"proto-version": "v2", "x-custom-keepalive": "true"},
                                  max_size=None, ping_interval=None) as ws:
        try:
            await ws.send(_request(app_key, "StartTask", "", b"", rid, 0))
            await _expect(ws, "TaskStarted")
            await ws.send(_request(app_key, "StartSession", session, b"", rid, 0))
            await _expect(ws, "SessionStarted")
        except Exception:
            _reset_device()
            raise

        async def receive():
            while True:
                r = _response(await ws.recv())
                if r["result"]:
                    tr.update(r["result"])
                if r["event"].endswith("Failed"):
                    raise HanbaoError(f"憨包 {r['event']} {r['status']}: {r['message']}")
                if r["event"] == "SessionFinished":
                    return
        rx = asyncio.create_task(receive())
        try:
            enc, ts0 = _Encoder(), int(time.time() * 1000)
            frames = _frames(audio)
            t0 = time.monotonic()
            for i, f in enumerate(frames):
                meta = json.dumps({"extra": {}, "timestamp_ms": ts0 + i * 20})
                await ws.send(_request("", "TaskRequest", meta, enc.encode(f), rid, FIRST if i == 0 else MIDDLE))
                if rx.done():
                    break
                # 发送节奏：最快 speed 倍速，但领先实时不超过 lead 秒。
                # 实测领先约 12 秒以上，服务端会提前结束会话、后面的音频直接丢掉（30 秒的段 4 倍速只认出前 13 秒）
                sent = (i + 1) * 0.02
                wait = max(sent / speed, sent - lead) - (time.monotonic() - t0)
                if wait > 0:
                    await asyncio.sleep(wait)
            meta = json.dumps({"extra": {}, "timestamp_ms": ts0 + len(frames) * 20})
            # 服务端处理速度约 3 倍实时；收到 FinishSession 时没处理完的音频会被直接丢掉，
            # 所以先等它追上（已出字到末尾附近，或 2.5 秒没有新进展——末尾是静音时不会再出字）
            dur, t1 = len(frames) * 0.02, time.monotonic()
            tr.progress_at = max(tr.progress_at, t1)
            while (not rx.done() and tr.progress < dur - 0.8 and time.monotonic() - tr.progress_at < 2.5
                   and time.monotonic() - t1 < 30 + dur):
                await asyncio.sleep(0.1)
            await ws.send(_request("", "TaskRequest", meta, b"", rid, LAST))
            await ws.send(_request(app_key, "FinishSession", "", b"", rid, 0))
            await asyncio.wait_for(rx, 10 + len(frames) / 200)
        except Exception as e:
            if not tr.text():
                if isinstance(e, HanbaoError) and "Failed" in str(e):
                    _reset_device()
                raise
            log.warning("hanbao session ended early but has text: %s", e)
        finally:
            rx.cancel()
    out = {"text": tr.text()}
    if raw:
        out["raw"] = tr.raw
    return out


async def recognize_async(audio: np.ndarray, speed: float = 4.0, lead: float = 10.0, rejection: bool = False,
                          raw: bool = False, retries: int = 1) -> dict:
    """识别一段 16k float32 音频。speed/lead：发送倍速与最多领先实时的秒数。
    rejection：服务端过滤背景人声（输入法默认开；会议/远场录音要关，否则远处说话大多返回空）。"""
    err = None
    for attempt in range(retries + 1):
        try:
            return await _session(audio, speed, lead, rejection, raw)
        except Exception as e:  # noqa: BLE001
            err = e
            log.info("hanbao attempt %d failed: %s", attempt + 1, e)
            await asyncio.sleep(0.5 + attempt)
    raise HanbaoError(str(err))


def recognize_many(segments: list[np.ndarray], concurrency: int = 6, **kw) -> list[dict | Exception]:
    """并发识别多段；单段失败返回异常对象，由调用方回退。没配置、没有 libopus 时直接抛错（不必每段都试一遍）。"""
    _cfg()
    _lib()

    async def run():
        sem = asyncio.Semaphore(concurrency)

        async def one(a):
            async with sem:
                try:
                    return await recognize_async(a, **kw)
                except Exception as e:  # noqa: BLE001
                    return e
        return await asyncio.gather(*(one(a) for a in segments))
    return asyncio.run(run())
