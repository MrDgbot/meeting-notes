"""会议记录本地服务。

启动:  ./start.sh  →  http://127.0.0.1:8770
"""
import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import lan
import prompts
import store
import vocab
from ambient import (SENS, Ambient, list_devices, purge_candidates, purge_old_audio, save_cfg as save_ambient_cfg,
                     sens_thres)
from asr_engine import ASR_MODELS, DEVICE, Engine, asr_mode, duration_of, fmt_ts, make_mp3, pcm_to_wav, to_wav16k
from llm import LLMError, chat, chat_stream

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = FastAPI(title="会议记录")
app.add_middleware(lan.Guard)  # 不是从本机来的请求（局域网里的平板、手机）要先用访问口令登录
app.include_router(lan.router)
lan.server.app = app
engine = Engine()
jobs = ThreadPoolExecutor(max_workers=1)
live_active: dict[str, bool] = {}
MODEL_FAIL = "语音模型加载失败"


# ---------------- 后台转写 ----------------
def run_transcribe(mid: str):
    try:
        d = store.mdir(mid)
        meta = store.get(mid)
        if meta is None:
            return
        wav = d / "audio.wav"
        mp3 = d / "audio.mp3"
        from_mp3 = False
        # 先把原始录音转成 wav：后面就算模型出错，网页上也能播放录音、点“重新转写”
        if (d / "audio.pcm").exists() and (not wav.exists() or (d / "audio.pcm").stat().st_mtime > wav.stat().st_mtime):
            pcm_to_wav(d / "audio.pcm", wav)
        if not wav.exists() and mp3.exists():  # 自动记录转写后只保留 mp3
            to_wav16k(mp3, wav)
            from_mp3 = True
        while not engine.ready:
            if engine.error and not engine.loading:
                raise RuntimeError(f"{MODEL_FAIL}: " + engine.error)
            time.sleep(1)
        dur = duration_of(wav)
        store.update(mid, status="transcribing", duration=dur, error="", job_started=time.time(),
                     job_estimate=max(5.0, dur / {"nano": 4, "hanbao": 10}.get(asr_mode(), 6) + (8 if asr_mode() == "hanbao" else 3)))
        # wav 是从 mp3 解出来的就不要再压回去：mp3 有损，每次重新转写都重压一遍，几次后音质明显变差
        if not from_mp3 and (not mp3.exists() or mp3.stat().st_mtime < wav.stat().st_mtime):
            make_mp3(wav, mp3)
        t = time.time()
        vad_kw = {"speech_noise_thres": sens_thres()} if meta.get("source") == "ambient" else None
        paras = engine.transcribe(wav, meta.get("num_spk", 0), vocab.hotwords(meta.get("hotword", "")), vad_kw)
        cost = time.time() - t
        store.save(mid, "transcript.json", {"paragraphs": paras, "device": DEVICE, "cost": round(cost, 1),
                                            "asr": engine.last_info,
                                            "num_spk_requested": meta.get("num_spk", 0),
                                            "created": datetime.now().isoformat(timespec="seconds")})
        n = len({p["spk"] for p in paras})
        store.update(mid, status="ready", num_speakers=n, transcribe_cost=round(cost, 1),
                     chars=sum(len(p["text"]) for p in paras))
        if meta.get("source") == "ambient":  # 全天记录量大：只留 mp3（约原始 pcm+wav 的 1/8）
            (d / "audio.pcm").unlink(missing_ok=True)
            wav.unlink(missing_ok=True)
        log.info("transcribed %s: %.0fs audio in %.1fs, %d speakers", mid, dur, cost, n)
    except Exception as e:  # noqa: BLE001
        log.exception("transcribe failed %s", mid)
        try:
            store.update(mid, status="error", error=str(e)[:500])
        except Exception:  # noqa: BLE001
            pass


def queue_transcribe(mid: str):
    store.update(mid, status="queued", error="")
    jobs.submit(run_transcribe, mid)


def load_models():
    """加载语音模型；成功后把之前因为模型加载失败而转写出错的记录重新排队。"""
    engine.load()
    if not engine.ready:
        return
    for m in store.list_all():
        if m["status"] == "error" and (m.get("error") or "").startswith(MODEL_FAIL):
            log.info("requeue %s after model load", m["id"])
            queue_transcribe(m["id"])


ambient = Ambient(engine, queue_transcribe)
DAILY = store.DATA / "daily"


@app.on_event("startup")
async def _startup():
    threading.Thread(target=load_models, daemon=True).start()
    if not vocab.PATH.exists() and ambient.cfg.get("hotword"):  # 常用热词从全天模式设置迁到词库
        vocab.save({"hotwords": ambient.cfg["hotword"]})
    # 恢复上次中断的任务
    for m in store.list_all():
        # 旧版的自动记录标题是固定的“自动记录 HH:MM”，改成占位标题，生成纪要后会自动换成有意义的标题
        if m.get("source") == "ambient" and not m.get("title_auto") and re.fullmatch(r"自动记录 \d{2}:\d{2}", m["title"]):
            store.update(m["id"], title_auto=True)
        if m["status"] == "recording" and _restore_orphan(m):
            continue
        if m["status"] in ("queued", "transcribing", "recording"):
            d = store.mdir(m["id"])
            if (d / "audio.pcm").exists() or (d / "audio.wav").exists() or (d / "audio.mp3").exists():
                queue_transcribe(m["id"])
            else:
                store.update(m["id"], status="new")
    if ambient.cfg.get("enabled"):
        ambient.start(restore=True)  # 等语音模型就绪后自动开始采集；上次暂停着的话继续暂停
    asyncio.get_running_loop().create_task(_housekeeping())
    asyncio.get_running_loop().create_task(lan.server.apply())  # 开着局域网访问的话，另起 HTTPS 端口


@app.on_event("shutdown")
async def _shutdown():
    await lan.server.stop()
    ambient.shutdown()
    _stop_local_llm()


# ---------------- 基础 ----------------
@app.get("/")
def index():
    # 给 js/css 加上修改时间作版本号，更新后浏览器不会用旧缓存
    st = store.BASE / "static"
    html = (st / "index.html").read_text("utf-8")
    for name in ("app.js", "style.css"):
        html = html.replace(f"/static/{name}\"", f"/static/{name}?v={int((st / name).stat().st_mtime)}\"")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health(request: Request):
    note = ""
    if engine.nano_loading:
        note = "正在加载 Fun-ASR-Nano（约 15 秒），这期间实时文字会暂停"
    elif engine.nano_error and asr_mode() in ("nano", "hanbao"):
        note = "Fun-ASR-Nano 加载失败，暂用 Paraformer：" + engine.nano_error[:120]
    return {"asr_ready": engine.ready, "asr_error": engine.error, "asr_loading": engine.loading, "asr_note": note,
            "device": DEVICE, "remote": not lan.is_local(request.scope),  # 网页是不是在别的设备上打开的
            "templates": {k: v["name"] for k, v in prompts.TEMPLATES.items()}}


@app.post("/api/asr/reload")
def reload_asr(request: Request):
    """语音模型加载失败后从网页上重试，不用重启服务。"""
    if not engine.ready and not engine.loading:
        threading.Thread(target=load_models, daemon=True).start()
        time.sleep(0.2)  # 等加载线程把 loading 置上，返回给网页的就是“加载中”
    return health(request)


@app.get("/api/asr")
def get_asr():
    return {"model": asr_mode(), "options": asr_options(), "nano_loaded": engine.nano is not None,
            "nano_loading": engine.nano_loading, "nano_error": engine.nano_error}


def asr_options() -> dict:
    """云端识别要有本机配置（data/hanbao.json，见 hanbao_asr.config）才出现在选项里；当前已选中的照常显示。"""
    import hanbao_asr
    return {k: v for k, v in ASR_MODELS.items() if k != "hanbao" or k == asr_mode() or hanbao_asr.config()}


@app.put("/api/asr")
def put_asr(body: dict = Body(...)):
    m = body.get("model")
    if m not in asr_options():
        raise HTTPException(400, "未知的识别模型")
    s = store.get_settings()
    s["asr"] = {**(s.get("asr") or {}), "model": m}
    store.save_settings(s)
    if engine.ready:  # 后台预加载，首次切到 Nano 约需 15 秒；之前加载失败过的话这里重试一次
        if m in ("nano", "hanbao") and engine.nano is None:
            engine.nano_loading = True
        threading.Thread(target=engine.ensure, args=(m, True), daemon=True).start()
    return get_asr()


def _meta_or_404(mid: str) -> dict:
    if not store.exists(mid):
        raise HTTPException(404, "会议不存在")
    return store.get(mid)


def _prov(pid: str | None) -> dict:
    try:
        return store.provider(pid)
    except KeyError as e:
        raise HTTPException(400, e.args[0]) from e


def _hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


def _minutes_stale(mid: str, meta: dict, mn: dict | None = None) -> list[str]:
    """纪要生成后，转写（改字、改说话人名、纠错规则、重新转写、续录）或笔记有没有变。
    返回变了的部分：transcript / notes；旧版生成的纪要没有记录来源，不判断。"""
    mn = mn if mn is not None else store.load(mid, "minutes.json")
    if not mn or not mn.get("src_hash"):
        return []
    out = []
    if mn["src_hash"] != _hash("\n".join(prompts.transcript_lines(meta, _paras(mid)))):
        out.append("transcript")
    if mn.get("notes_hash") is not None and mn["notes_hash"] != _hash(_notes(mid).strip()):
        out.append("notes")
    return out


@app.get("/api/meetings")
def list_meetings():
    return store.list_all()


@app.post("/api/meetings")
def create_meeting(body: dict = Body(default={})):
    return store.create(
        title=body.get("title", ""),
        num_spk=int(body.get("num_spk") or 0),
        hotword=body.get("hotword", ""),
        template=body.get("template", "general"),
        source="mic",
    )


@app.post("/api/meetings/upload")
def upload_meeting(file: UploadFile = File(...), title: str = Form(""), num_spk: int = Form(0),
                   hotword: str = Form(""), template: str = Form("general")):
    name = file.filename or "录音"
    meta = store.create(title=title or re.sub(r"\.[^.]+$", "", name), num_spk=num_spk, hotword=hotword,
                        template=template, source="upload", filename=name)
    d = store.mdir(meta["id"])
    raw = d / ("upload" + (re.search(r"\.[^.]+$", name).group(0) if "." in name else ".bin"))
    with open(raw, "wb") as f:
        while chunk := file.file.read(1 << 20):
            f.write(chunk)
    try:
        to_wav16k(raw, d / "audio.wav")
    except Exception as e:  # noqa: BLE001  解码失败、没装 ffmpeg、磁盘满……都不要留下一条空会议
        store.delete(meta["id"])
        msg = str(e) if isinstance(e, RuntimeError) else f"音频处理失败：{type(e).__name__} {e}"
        raise HTTPException(400, msg[:300]) from e
    finally:
        raw.unlink(missing_ok=True)
    queue_transcribe(meta["id"])
    return store.get(meta["id"])


@app.get("/api/meetings/{mid}")
def get_meeting(mid: str):
    meta = _meta_or_404(mid)
    d = store.mdir(mid)
    c = ambient.conv
    active = bool(live_active.get(mid) or (c and c.mid == mid))
    mn = store.load(mid, "minutes.json")
    return {
        "meta": meta,
        "transcript": _fixed_transcript(mid),
        "live": vocab.apply_paras(store.load(mid, "live.json", [])),
        "segmap": store.load(mid, "segmap.json"),
        "minutes": mn,
        "minutes_stale": _minutes_stale(mid, meta, mn),
        "notes": (d / "notes.md").read_text("utf-8") if (d / "notes.md").exists() else "",
        "qa": store.load(mid, "qa.json", []),
        # 只剩原始 pcm（转写前就出错）也算有录音：能播放（按需转 wav）、能重新转写
        "has_audio": (d / "audio.mp3").exists() or (d / "audio.wav").exists() or ((d / "audio.pcm").exists() and not active),
        "live_active": live_active.get(mid, False),
        "live_state": _live_state(mid),  # 录音中 / 断线等重连
        "ambient_active": bool(c and c.mid == mid),
    }


def _fixed_transcript(mid: str) -> dict | None:
    tr = store.load(mid, "transcript.json")
    if tr and tr.get("paragraphs"):
        tr["paragraphs"] = vocab.apply_paras(tr["paragraphs"])
    return tr


@app.put("/api/meetings/{mid}/paragraphs/{i}")
def edit_paragraph(mid: str, i: int, body: dict = Body(...)):
    """手动修改一段转写：text（空字符串 = 删除这段）、spk（改说话人）。重新转写会覆盖手动修改。"""
    _meta_or_404(mid)
    c = ambient.conv
    if live_active.get(mid) or (c and c.mid == mid):
        raise HTTPException(409, "正在记录，结束后再修改")
    tr = store.load(mid, "transcript.json")
    if tr and tr.get("paragraphs"):
        ps, name = tr["paragraphs"], "transcript.json"
    else:
        tr, ps, name = None, store.load(mid, "live.json", []), "live.json"
    if not 0 <= i < len(ps):
        raise HTTPException(404, "段落不存在")
    text = str(body["text"] or "").strip() if "text" in body else None
    if text == "":
        ps.pop(i)
    else:
        if text is not None:
            ps[i].update(text=text, edited=True)
        if "spk" in body and tr is not None:
            ps[i].update(spk=int(body["spk"]), edited=True)
    store.save(mid, name, tr if tr is not None else ps)
    if tr is not None:
        store.update(mid, num_speakers=len({p["spk"] for p in ps}))
    return get_meeting(mid)


@app.get("/api/vocab")
def get_vocab():
    return vocab.get()


@app.put("/api/vocab")
def put_vocab(body: dict = Body(...)):
    return vocab.save(body)


@app.post("/api/vocab/fix")
def add_vocab_fix(body: dict = Body(...)):
    a, b = (body.get("from") or "").strip(), (body.get("to") or "").strip()
    if not a or a == b:
        raise HTTPException(400, "规则不完整")
    return vocab.add_fix(a, b, bool(body.get("hotword")))


@app.patch("/api/meetings/{mid}")
def patch_meeting(mid: str, body: dict = Body(...)):
    _meta_or_404(mid)
    allowed = {k: body[k] for k in ("title", "num_spk", "hotword", "template", "speakers") if k in body}
    if "title" in allowed:
        allowed["title_auto"] = False
    if "notes" in body:
        (store.mdir(mid) / "notes.md").write_text(body["notes"], "utf-8")
    if "minutes_markdown" in body:
        mn = store.load(mid, "minutes.json") or {}
        mn.update(markdown=body["minutes_markdown"], edited=True)
        store.save(mid, "minutes.json", mn)
    return store.update(mid, **allowed) if allowed else store.get(mid)


@app.delete("/api/meetings/{mid}")
def delete_meeting(mid: str):
    _meta_or_404(mid)
    if live_active.get(mid):
        raise HTTPException(409, "正在录音，先结束录音")
    ambient.discard(mid)  # 正在全天记录的这段：停止写入、不转写
    store.delete(mid)
    return {"ok": True}


@app.post("/api/meetings/{mid}/transcribe")
def retranscribe(mid: str, body: dict = Body(default={})):
    meta = _meta_or_404(mid)
    c = ambient.conv
    if meta["status"] in ("queued", "transcribing") or live_active.get(mid) or (c and c.mid == mid):
        raise HTTPException(409, "正在处理中")
    d = store.mdir(mid)
    if not any((d / n).exists() for n in ("audio.wav", "audio.pcm", "audio.mp3")):
        raise HTTPException(400, "没有录音")
    fields = {}
    if "num_spk" in body:
        fields["num_spk"] = int(body["num_spk"] or 0)
    if "hotword" in body:
        fields["hotword"] = body["hotword"]
    if fields:
        store.update(mid, **fields)
    queue_transcribe(mid)
    return store.get(mid)


@app.get("/api/meetings/{mid}/audio")
def audio(mid: str):
    _meta_or_404(mid)
    d = store.mdir(mid)
    c = ambient.conv
    if not (d / "audio.mp3").exists() and not (d / "audio.wav").exists() and (d / "audio.pcm").exists() \
            and not live_active.get(mid) and not (c and c.mid == mid):
        pcm_to_wav(d / "audio.pcm", d / "audio.wav")
    for name, mt in (("audio.mp3", "audio/mpeg"), ("audio.wav", "audio/wav")):
        if (d / name).exists():
            return FileResponse(d / name, media_type=mt)
    raise HTTPException(404, "没有录音")


# ---------------- 实时录音 ----------------
# 手机、平板上网络会断（锁屏、切到别的应用、Wi-Fi 抖动、换网络），断线不等于录音结束：
# - 网页给每次录音一个编号 rec，音频按固定大小（3200 字节 = 100ms）顺序发来，没确认的块留在网页内存里；
# - 服务端每秒回一次 ack：这次录音已经落盘多少字节，网页据此删掉本地缓存；
# - 断线后网页带同一个 rec 重连，服务端回 ready（含 pcm 文件当前字节数），网页从那里补发；
# - 断开超过 LIVE_GRACE_S（默认 15 分钟，和网页的缓存上限一致）才收尾、排队转写；在 Mac 上也可以手动“现在结束”。
# - 录音本身中断（锁屏、来电、麦克风被占用、缓存满了）时网页发 gap，记进 meta.rec_health，转写稿里标出来。
LIVE_GRACE_S = float(os.environ.get("LIVE_GRACE_S") or 15 * 60)
CHUNK_BYTES = 3200
GAP_REASONS = {"hidden", "interrupted", "muted", "overflow", "stall"}


class LiveRec:
    """一次录音（rec）。可能跨好几条 WebSocket 连接，服务重启后也能接回来。"""

    def __init__(self, mid: str, rec: str, start_bytes: int, health: dict):
        self.mid, self.rec, self.start_bytes, self.h = mid, rec, start_bytes, health
        self.sess = None
        self.ws: WebSocket | None = None  # 当前连接；None = 断线等重连
        self.feed_lock = asyncio.Lock()  # 新旧两条连接不能同时往同一个 LiveSession 里写
        self.timer: asyncio.Task | None = None
        self.detached_at: float | None = None
        self.done = False

    @property
    def received(self) -> int:
        size = self.sess.file_bytes if self.sess else _pcm_size(self.mid)
        return max(0, size - self.start_bytes)


LIVE: dict[str, LiveRec] = {}


def _pcm_size(mid: str) -> int:
    p = store.mdir(mid) / "audio.pcm"
    return p.stat().st_size if p.exists() else 0


def _align_pcm(mid: str, start: int) -> None:
    """服务重启后接回录音：pcm 末尾可能只写了半块，截到整块，网页会从这里补发。"""
    p = store.mdir(mid) / "audio.pcm"
    if not p.exists():
        return
    size = p.stat().st_size
    keep = start + max(0, size - start) // CHUNK_BYTES * CHUNK_BYTES
    if keep < size:
        with open(p, "r+b") as f:
            f.truncate(keep)
        log.info("live %s: truncated pcm %d -> %d", mid, size, keep)


def _device(ws: WebSocket) -> str:
    ua = ws.headers.get("user-agent", "")
    for k, v in (("MicroMessenger", "微信"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "安卓"), ("Macintosh", "Mac / iPad"), ("Windows", "Windows")):
        if k in ua:
            return v
    return "浏览器"


def _save_health(ctx: LiveRec) -> None:
    meta = store.get(ctx.mid)
    if not meta:
        return
    ctx.h["received"] = ctx.received
    hs = [h for h in meta.get("rec_health") or [] if h.get("rec") != ctx.rec]
    store.update(ctx.mid, rec_health=[*hs, ctx.h][-30:])


def _persist_finals(mid: str, events: list[dict]) -> None:
    finals = [{k: e[k] for k in ("start", "end", "text")} for e in events if e["type"] == "final"]
    if finals:
        store.save(mid, "live.json", store.load(mid, "live.json", []) + finals)


def _live_state(mid: str) -> dict | None:
    ctx = LIVE.get(mid)
    if not ctx:
        return None
    if ctx.ws is not None:
        return {"state": "recording", "device": ctx.h.get("device")}
    left = LIVE_GRACE_S - (time.time() - (ctx.detached_at or time.time()))
    return {"state": "reconnecting", "device": ctx.h.get("device"), "since": ctx.detached_at, "grace_left": max(0, round(left))}


async def _live_finalize(ctx: LiveRec, end: str, queue: bool = True) -> list[dict]:
    """收尾一次录音：把最后一句识别完、记下健康记录，然后（默认）排队精准转写。"""
    if ctx.done:
        return []
    ctx.done = True
    if ctx.timer and ctx.timer is not asyncio.current_task():
        ctx.timer.cancel()
    events = []
    async with ctx.feed_lock:
        if ctx.sess:
            try:
                events = await asyncio.to_thread(ctx.sess.finish)
            except Exception:  # noqa: BLE001
                log.exception("finish live")
                ctx.sess.close()
    mid = ctx.mid
    _persist_finals(mid, events)
    ctx.h.update(ended=datetime.now().isoformat(timespec="seconds"), end=end)
    _save_health(ctx)
    if LIVE.get(mid) is ctx:
        LIVE.pop(mid, None)
        live_active.pop(mid, None)
        ambient.release(mid)
    store.update(mid, live_rec=None, live_state=None)
    log.info("live %s rec %s ended (%s): %d bytes, %d reconnects, %d gaps", mid, ctx.rec, end, ctx.h["received"],
             ctx.h["reconnects"], len(ctx.h["gaps"]))
    if queue:
        size = _pcm_size(mid)
        if size > 16000 * 2:  # 超过 1 秒才转写
            store.update(mid, duration=size / 32000)
            queue_transcribe(mid)
        else:
            store.update(mid, status="new" if not store.load(mid, "live.json") else "ready")
    return events


async def _live_expire(ctx: LiveRec) -> None:
    while not engine.ready and not engine.error:  # 服务刚重启、模型还没加载好时网页也连不上：从能连上的时候开始算
        await asyncio.sleep(1)
    await asyncio.sleep(LIVE_GRACE_S)
    if ctx.ws is None and not ctx.done:
        log.info("live %s: no reconnect within %.0fs, finishing", ctx.mid, LIVE_GRACE_S)
        await _live_finalize(ctx, "timeout")


def _live_detach(ctx: LiveRec) -> None:
    ctx.ws = None
    ctx.detached_at = time.time()
    _save_health(ctx)
    store.update(ctx.mid, live_state={"state": "reconnecting", "since": ctx.detached_at})
    ctx.timer = asyncio.create_task(_live_expire(ctx))


def _restore_orphan(meta: dict) -> bool:
    """服务重启前正在录的会议：先别转写，等网页重连接着录（等不到再收尾）。"""
    lr = meta.get("live_rec") or {}
    if meta.get("source") != "mic" or not lr.get("rec"):
        return False
    mid = meta["id"]
    h = next((x for x in meta.get("rec_health") or [] if x.get("rec") == lr["rec"]), None) or {
        "rec": lr["rec"], "device": "", "started": "", "ended": None, "end": "", "start_bytes": lr.get("start_bytes", 0),
        "reconnects": 0, "gaps": [], "produced": 0, "dropped": 0, "received": 0}
    h.setdefault("restarts", 0)
    h["restarts"] += 1
    ctx = LiveRec(mid, lr["rec"], int(lr.get("start_bytes") or 0), h)
    LIVE[mid] = ctx
    live_active[mid] = True
    ambient.hold(mid)
    _live_detach(ctx)
    log.info("live %s: waiting for rec %s to reconnect after restart", mid, ctx.rec)
    return True


@app.post("/api/meetings/{mid}/live/end")
async def live_end(mid: str):
    """在别的设备上结束一次录音：还连着就让录音的网页自己结束（把剩下的传完），断线等重连的直接收尾。"""
    _meta_or_404(mid)
    ctx = LIVE.get(mid)
    if not ctx:
        raise HTTPException(404, "这个会议现在没有在录音")
    if ctx.ws is not None:
        try:
            await ctx.ws.send_json({"type": "end_requested"})
            return {"ok": True, "pending": True}
        except Exception:  # noqa: BLE001 —— 连接其实已经断了：按断线处理
            log.info("live %s: end_requested not delivered, finishing here", mid)
    await _live_finalize(ctx, "ended_by_user")
    return {"ok": True}


@app.websocket("/ws/live/{mid}")
async def ws_live(ws: WebSocket, mid: str, rec: str = ""):
    await ws.accept()

    async def fail(msg: str, code: str = "") -> None:
        await ws.send_json({"type": "error", "msg": msg, "code": code})
        await ws.close()

    if not store.exists(mid):
        return await fail("会议不存在", "gone")
    ctx = LIVE.get(mid)
    if ctx and ctx.rec != rec and ctx.ws is not None:
        return await fail("这个会议已在另一个页面录音", "busy")
    while not engine.ready:
        if engine.error:
            return await fail("语音模型加载失败: " + engine.error)
        await ws.send_json({"type": "status", "msg": "语音模型加载中…"})
        await asyncio.sleep(1)
    meta = store.get(mid)
    d = store.mdir(mid)
    if meta.get("source") in ("upload", "ambient"):
        return await fail("上传的录音和自动记录不能续录")
    ended = next((h for h in meta.get("rec_health") or [] if rec and h.get("rec") == rec and h.get("ended")), None)
    if ended:  # 这次录音已经收尾了（“结束”的回执丢了，或者断开太久被收尾）：告诉网页落盘到哪里，它自己算丢了多少
        await ws.send_json({"type": "stopped", "already": True, "end": ended.get("end"),
                            "file_bytes": int(ended.get("start_bytes") or 0) + int(ended.get("received") or 0)})
        return await ws.close()
    ctx = LIVE.get(mid)  # 等模型的时候可能变了
    if ctx and ctx.rec != rec:
        if ctx.ws is not None:
            return await fail("这个会议已在另一个页面录音", "busy")
        await _live_finalize(ctx, "takeover", queue=False)  # 断线后没回来的那次录音：收尾，新的接着录在后面
        ctx = None
    if ctx is None and meta["status"] in ("queued", "transcribing"):
        return await fail("正在转写这个会议，转写完再续录", "busy")
    resumed = ctx is not None
    if not resumed:
        rec = rec or secrets.token_hex(8)
        start = _pcm_size(mid)
        start -= start % 2
        ctx = LiveRec(mid, rec, start, {"rec": rec, "device": _device(ws), "started": datetime.now().isoformat(timespec="seconds"),
                                        "ended": None, "end": "", "start_bytes": start, "reconnects": 0, "gaps": [],
                                        "produced": 0, "dropped": 0, "received": 0})
        LIVE[mid] = ctx
        live_active[mid] = True
        ambient.hold(mid)  # 手动录音期间暂停全天采集，避免同一段话录两遍
    else:
        if ctx.timer:
            ctx.timer.cancel()
            ctx.timer = None
        ctx.h["reconnects"] += 1
        ctx.h["device"] = ctx.h.get("device") or _device(ws)
    old = ctx.ws
    async with ctx.feed_lock:  # 换成新连接：旧连接（半开、还没察觉断了的）之后收到的数据都丢掉，网页会按 file_bytes 补发
        if ctx.sess is None:  # 新录音，或者服务重启后第一次连回来
            if resumed:
                _align_pcm(mid, ctx.start_bytes)
            ctx.sess = engine.live_session(d / "audio.pcm", vocab.hotwords(meta.get("hotword", "")))
        ctx.ws, ctx.detached_at = ws, None
        file_bytes = ctx.sess.file_bytes
    if old is not None:
        asyncio.create_task(_close_quietly(old))
    store.update(mid, status="recording", source="mic", live_rec={"rec": ctx.rec, "start_bytes": ctx.start_bytes}, live_state=None)
    _save_health(ctx)
    await ws.send_json({"type": "ready", "rec": ctx.rec, "offset_ms": ctx.start_bytes // 32, "start_bytes": ctx.start_bytes,
                        "file_bytes": file_bytes, "resumed": resumed, "grace_s": LIVE_GRACE_S})
    if resumed:
        log.info("live %s rec %s resumed at %d bytes (reconnect #%d)", mid, ctx.rec, file_bytes - ctx.start_bytes, ctx.h["reconnects"])

    async def emit(events, persist=True):
        if persist:
            _persist_finals(mid, events)
        for e in events:
            await ws.send_json({**e, "text": vocab.apply(e["text"])} if e.get("text") else e)

    stopped = False
    last_ack = 0.0
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect" or ctx.ws is not ws:
                break
            if msg.get("bytes"):
                async with ctx.feed_lock:
                    if ctx.ws is not ws or ctx.done:
                        break
                    events = await asyncio.to_thread(ctx.sess.feed, msg["bytes"])
                await emit(events)
                now = time.monotonic()
                if now - last_ack >= 1:
                    last_ack = now
                    await ws.send_json({"type": "ack", "bytes": ctx.received})
            elif msg.get("text"):
                j = json.loads(msg["text"])
                t = j.get("type")
                if t in ("stat", "stop"):
                    ctx.h["produced"] = int(j.get("produced") or 0)
                    ctx.h["dropped"] = int(j.get("dropped") or 0)
                if t == "stop":
                    await emit(await _live_finalize(ctx, "stop"), persist=False)
                    stopped = True
                    break
                if t == "gap" and len(ctx.h["gaps"]) < 500:
                    ctx.h["gaps"].append({"at_ms": int(j.get("at_ms") or 0), "dur_ms": int(j.get("dur_ms") or 0),
                                          "reason": j.get("reason") if j.get("reason") in GAP_REASONS else "stall"})
                    _save_health(ctx)
                elif t == "stat":
                    _save_health(ctx)
                    await ws.send_json({"type": "ack", "bytes": ctx.received})  # 网页停着不发音频时（暂停）也能收到确认
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if ctx.ws is ws and not ctx.done:
            log.info("live %s rec %s disconnected at %d bytes, waiting up to %.0fs", mid, ctx.rec, ctx.received, LIVE_GRACE_S)
            _live_detach(ctx)
    if stopped:
        try:
            await ws.send_json({"type": "stopped", "file_bytes": ctx.start_bytes + ctx.h["received"]})
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


async def _close_quietly(ws: WebSocket) -> None:
    with contextlib.suppress(Exception):
        await asyncio.wait_for(ws.close(code=4001), 3)


# ---------------- AI 纪要 / 问答 ----------------
def _ndjson(obj) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _notes(mid: str) -> str:
    p = store.mdir(mid) / "notes.md"
    return p.read_text("utf-8") if p.exists() else ""


def _paras(mid: str) -> list[dict]:
    tr = store.load(mid, "transcript.json")
    if tr and tr.get("paragraphs"):
        return vocab.apply_paras(tr["paragraphs"])
    # 会后转写未完成时，用实时转写稿
    return [{"spk": 0, "start": x["start"], "end": x["end"], "text": x["text"]}
            for x in vocab.apply_paras(store.load(mid, "live.json", []))]


@app.post("/api/meetings/{mid}/minutes")
async def gen_minutes(mid: str, body: dict = Body(default={})):
    meta = _meta_or_404(mid)
    template = body.get("template") or meta.get("template") or "general"
    prov = _prov(body.get("provider"))
    paras = _paras(mid)
    if not paras:
        raise HTTPException(400, "还没有转写内容")
    notes = _notes(mid)
    lines = prompts.transcript_lines(meta, paras)
    budget = int(prov.get("max_input_chars") or 60000)

    async def gen():
        t0 = time.time()
        out = ""
        try:
            total = sum(len(x) + 1 for x in lines)
            if total <= budget:
                msgs = prompts.minutes_messages(meta, notes, template, "\n".join(lines))
            else:
                chunks = prompts.chunk_lines(lines, int(budget * 0.8))
                parts = []
                for i, ch in enumerate(chunks, 1):
                    yield _ndjson({"type": "status", "msg": f"会议较长，正在分段提炼 {i}/{len(chunks)}…"})
                    parts.append(f"【第 {i} 部分】\n" + await chat(prov, [
                        {"role": "system", "content": "你是会议纪要助手，擅长提炼要点。"},
                        {"role": "user", "content": prompts.MAP_PROMPT.format(i=i, n=len(chunks), text="\n".join(ch))},
                    ], max_tokens=3000))
                msgs = prompts.minutes_messages(meta, notes, template, "\n\n".join(parts), partial=True)
            yield _ndjson({"type": "status", "msg": f"{prov['name']} 生成中…"})
            async for delta in chat_stream(prov, msgs):
                out += delta
                yield _ndjson({"type": "delta", "text": delta})
            out = out.strip()
            rec = {"markdown": out, "template": template, "provider": prov["name"], "model": prov["model"],
                   "created": datetime.now().isoformat(timespec="seconds"), "cost": round(time.time() - t0, 1),
                   # 记下生成时用的转写和笔记，之后有改动时提示“纪要可能已过期”
                   "src_hash": _hash("\n".join(lines)), "notes_hash": _hash(notes.strip()),
                   "from_live": not (store.load(mid, "transcript.json") or {}).get("paragraphs")}
            store.save(mid, "minutes.json", rec)
            m = re.match(r"#\s+(.+)", out)
            cur = store.get(mid)
            if m and cur.get("title_auto"):
                store.update(mid, title=m.group(1).strip()[:40], title_auto=False)
            yield _ndjson({"type": "done", "minutes": rec})
        except LLMError as e:
            yield _ndjson({"type": "error", "msg": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("minutes")
            yield _ndjson({"type": "error", "msg": f"{type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


def _bigrams(s: str) -> set:
    s = re.sub(r"\W", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1)}


@app.post("/api/meetings/{mid}/ask")
async def ask(mid: str, body: dict = Body(...)):
    meta = _meta_or_404(mid)
    q = (body.get("question") or "").strip()
    if not q:
        raise HTTPException(400, "问题为空")
    prov = _prov(body.get("provider"))
    lines = prompts.transcript_lines(meta, _paras(mid))
    mn = store.load(mid, "minutes.json") or {}
    # 纪要生成后转写改过的话，旧纪要里的名字和内容可能是错的，不拿来当参考
    minutes = "" if "transcript" in _minutes_stale(mid, meta, mn) else mn.get("markdown", "")
    maxc = int(prov.get("max_input_chars") or 60000)
    if len(minutes) > maxc * 0.4:
        minutes = minutes[: int(maxc * 0.4)]
    budget = max(int(maxc * 0.5), maxc - len(minutes) - 2000)
    if sum(len(x) + 1 for x in lines) > budget:
        # 太长：按与问题的字词重合度挑选相关片段（保留前后文）
        qb = _bigrams(q)
        scored = sorted(range(len(lines)), key=lambda i: -len(qb & _bigrams(lines[i])))
        keep, n = set(), 0
        for i in scored:
            for j in (i - 1, i, i + 1):
                if 0 <= j < len(lines) and j not in keep and n + len(lines[j]) < budget:
                    keep.add(j)
                    n += len(lines[j]) + 1
        lines = [lines[i] for i in sorted(keep)]
    ctx = prompts.context_header(meta, _notes(mid))
    if minutes:
        ctx += "\n\n已生成的会议纪要：\n" + minutes
    ctx += "\n\n会议转写稿：\n" + "\n".join(lines)
    history = store.load(mid, "qa.json", [])
    msgs = [{"role": "system", "content": prompts.QA_SYSTEM}, {"role": "user", "content": ctx},
            {"role": "assistant", "content": "好的，我已阅读会议内容，请提问。"}]
    for h in history[-6:]:
        msgs += [{"role": "user", "content": h["q"]}, {"role": "assistant", "content": h["a"]}]
    msgs.append({"role": "user", "content": q})

    async def gen():
        out = ""
        try:
            async for delta in chat_stream(prov, msgs, max_tokens=2000):
                out += delta
                yield _ndjson({"type": "delta", "text": delta})
            if store.exists(mid):  # 保存时重新读一遍：同时问了两个问题时，先答完的那条不会被覆盖
                with _qa_lock:
                    cur = store.load(mid, "qa.json", [])
                    cur.append({"q": q, "a": out.strip(), "t": datetime.now().isoformat(timespec="seconds")})
                    store.save(mid, "qa.json", cur)
            yield _ndjson({"type": "done"})
        except LLMError as e:
            yield _ndjson({"type": "error", "msg": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("ask")
            yield _ndjson({"type": "error", "msg": f"{type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


_qa_lock = threading.Lock()


@app.delete("/api/meetings/{mid}/qa")
def clear_qa(mid: str):
    _meta_or_404(mid)
    store.save(mid, "qa.json", [])
    return {"ok": True}


# ---------------- 导出 ----------------
def _srt_ts(ms: int) -> str:
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


@app.get("/api/meetings/{mid}/export")
def export(mid: str, fmt: str = "md"):
    meta = _meta_or_404(mid)
    paras = _paras(mid)
    name = lambda p: prompts.spk_name(meta, p["spk"])  # noqa: E731
    if fmt == "srt":
        body = "\n".join(f"{i}\n{_srt_ts(p['start'])} --> {_srt_ts(p['end'])}\n{name(p)}：{p['text']}\n"
                         for i, p in enumerate(paras, 1))
    elif fmt == "txt":
        body = "\n\n".join(f"[{fmt_ts(p['start'])}] {name(p)}：{p['text']}" for p in paras)
    else:
        mrec = store.load(mid, "minutes.json") or {}
        mn = mrec.get("markdown", "")
        if mn and "transcript" in _minutes_stale(mid, meta, mrec):
            mn += "\n\n> 注意：这份纪要生成后，转写内容（文字或说话人姓名）有改动，纪要可能没有反映最新内容。"
        notes = _notes(mid)
        parts = [mn or f"# {meta['title']}",
                 f"\n> 时间：{meta['created'].replace('T', ' ')}　时长：{fmt_ts(meta.get('duration', 0) * 1000)}"]
        if notes.strip():
            parts.append("\n## 我的笔记\n\n" + notes.strip())
        parts.append("\n## 完整转写\n")
        parts += [f"**{name(p)}** [{fmt_ts(p['start'])}]：{p['text']}\n" for p in paras]
        body = "\n".join(parts)
        fmt = "md"
    fname = re.sub(r'[\\/:*?"<>|]', "_", meta["title"]) + "." + fmt
    from urllib.parse import quote
    return PlainTextResponse(body, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"})


# ---------------- 设置 ----------------
def _mask(k: str) -> str:
    return (k[:3] + "…" + k[-4:]) if k and len(k) > 10 else ("…" if k else "")


@app.get("/api/settings")
def get_settings():
    s = store.get_settings()
    out = json.loads(json.dumps(s))
    for p in out["providers"]:
        env_set = bool(p.get("env_key")) and bool(os.environ.get(p["env_key"]))
        p["api_key_masked"] = _mask(p.get("api_key", ""))
        p["api_key_from_env"] = env_set and not p.get("api_key")
        p.pop("api_key", None)
    return out


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    cur = store.get_settings()
    old = {p["id"]: p for p in cur["providers"]}
    provs = []
    used = set()
    for p in body.get("providers", []):
        pid = p.get("id") or re.sub(r"\W", "", p.get("name", "custom")).lower() or f"p{int(time.time())}"
        while pid in used:
            pid += "_2"
        used.add(pid)
        key = p.get("api_key")
        if key is None or key == "" and p.get("keep_key", True):
            key = old.get(pid, {}).get("api_key", "")
        extra = p.get("extra_body") or {}
        if isinstance(extra, str):
            try:
                extra = json.loads(extra) if extra.strip() else {}
            except json.JSONDecodeError as e:
                raise HTTPException(400, f"「{p.get('name')}」的额外参数不是合法 JSON") from e
        provs.append({"id": pid, "name": p.get("name") or pid, "base_url": p.get("base_url", "").strip(),
                      "api_key": key.strip(), "env_key": p.get("env_key", old.get(pid, {}).get("env_key", "")),
                      "model": p.get("model", "").strip(), "max_input_chars": int(p.get("max_input_chars") or 60000),
                      "extra_body": extra})
    # 默认接口按序号传：设置页里刚添加、还没保存过的接口没有 id，按 id 选不中它
    ai = body.get("active_index")
    if isinstance(ai, int) and 0 <= ai < len(provs):
        active = provs[ai]["id"]
    else:
        active = body.get("active") or ""
    if not any(p["id"] == active for p in provs):
        active = provs[0]["id"] if provs else ""
    cur.update(active=active, providers=provs)
    store.save_settings(cur)
    return get_settings()


@app.post("/api/settings/restore-providers")
def restore_providers():
    n = store.restore_default_providers()
    return {**get_settings(), "restored": n}


@app.post("/api/settings/test")
async def test_provider(body: dict = Body(...)):
    prov = _prov(body.get("id"))
    t = time.time()
    try:
        out = await chat(prov, [{"role": "user", "content": "只回复两个字：你好"}], max_tokens=20)
        return {"ok": True, "reply": out.strip()[:50], "latency": round(time.time() - t, 2)}
    except LLMError as e:
        return {"ok": False, "msg": str(e)}


# ---------------- 全天模式 ----------------
_today: dict = {"key": None, "t": 0.0, "val": None}


def _amb_today() -> dict:
    """今天的自动记录段数和发言时长。要读所有会议的 meta，推送频繁，缓存 5 秒（换了一段对话立即重算）。"""
    c = ambient.conv
    today = datetime.now().strftime("%Y-%m-%d")
    key = (today, c.mid if c else "")
    if _today["key"] != key or time.time() - _today["t"] > 5:
        ms = [m for m in store.list_all() if m["created"][:10] == today and m.get("source") == "ambient"]
        _today.update(key=key, t=time.time(),
                      val={"date": today, "count": len(ms), "speech_s": round(sum(m.get("speech_s", 0) for m in ms))})
    return _today["val"]


@app.get("/api/ambient")
def ambient_status():
    st = ambient.status()
    st["today"] = _amb_today()
    return st


@app.websocket("/ws/ambient")
async def ws_ambient(ws: WebSocket):
    """全天模式状态推送：有没有人在说话、音量、说话过程中的临时文字、实时文字版本号，有变化就推（最快 0.15 秒一次）。
    网页原来每 2 秒轮询一次状态、每 4 秒刷新一次文字，开口后要 1~3 秒才显示“有人在说话”。
    有网页连着时才在说话过程中出临时文字（省 GPU）。"""
    await ws.accept()
    ambient.viewers += 1
    recv = asyncio.ensure_future(ws.receive())
    last, sent_at = None, 0.0
    try:
        while True:
            done, _ = await asyncio.wait({recv}, timeout=0.15)
            if done:  # 网页关闭或服务退出；网页不会主动发消息
                if recv.result()["type"] == "websocket.disconnect":
                    break
                recv = asyncio.ensure_future(ws.receive())
            st = await asyncio.to_thread(ambient_status)
            if st != last or time.time() - sent_at > 20:  # 没变化时 20 秒发一次心跳
                await ws.send_json(st)
                last, sent_at = st, time.time()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        ambient.viewers -= 1
        recv.cancel()


@app.post("/api/ambient")
def ambient_action(body: dict = Body(...)):
    act = body.get("action")
    if act == "start":
        ambient.start()
    elif act == "stop":
        ambient.stop()
    elif act == "pause":
        ambient.pause(float(body.get("minutes") or 0))
    elif act == "resume":
        ambient.resume()
    elif act == "split":
        ambient.split()
    else:
        raise HTTPException(400, "未知操作")
    return ambient_status()


@app.put("/api/ambient/config")
def ambient_config(body: dict = Body(...)):
    cfg = dict(ambient.cfg)
    for k, typ in (("device", str), ("hotword", str), ("summary_time", str), ("split_min", float),
                   ("min_speech_s", float), ("max_conv_min", float), ("audio_keep_days", int), ("keep_awake", bool),
                   ("sensitivity", str)):
        if k in body:
            try:
                cfg[k] = typ(body[k]) if body[k] is not None else cfg[k]
            except (TypeError, ValueError) as e:
                raise HTTPException(400, f"参数 {k} 不合法") from e
    if cfg["summary_time"] and not re.fullmatch(r"\d{1,2}:\d{2}", cfg["summary_time"].strip()):
        raise HTTPException(400, "汇总时间格式应为 HH:MM")
    if cfg["sensitivity"] not in SENS:
        raise HTTPException(400, "灵敏度应为 " + " / ".join(SENS))
    cfg["split_min"] = min(max(cfg["split_min"], 1), 60)
    cfg["max_conv_min"] = min(max(cfg["max_conv_min"], 10), 240)
    cfg["min_speech_s"] = min(max(cfg["min_speech_s"], 0), 600)
    cfg["enabled"] = ambient.cfg.get("enabled", False)
    save_ambient_cfg(cfg)
    ambient.reload_cfg()
    return ambient_status()


@app.get("/api/ambient/devices")
def ambient_devices():
    return {"devices": list_devices()}


@app.get("/api/ambient/purge-preview")
def ambient_purge_preview(days: int):
    """把录音保留天数改成 days 后，会删掉多少段录音（保存设置前让用户确认）。"""
    return {"count": len(purge_candidates(days))}


# ---------------- 本地 AI 模型（llama-server） ----------------
LLM_SCRIPT = store.BASE / "scripts" / "start-local-llm.sh"
LLM_LOG = store.DATA / "local-llm.log"
_llm: dict = {"proc": None}


def _local_url() -> str:
    for p in store.get_settings().get("providers", []):
        if p["id"] == "local":
            return p["base_url"]
    return "http://127.0.0.1:8090/v1"


def _stop_local_llm():
    p = _llm["proc"]
    if p and p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(timeout=10)
        except Exception:  # noqa: BLE001
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass
    _llm["proc"] = None


@app.get("/api/llm/local")
async def local_llm_status():
    url = _local_url().rstrip("/")
    running = False
    try:
        async with httpx.AsyncClient(timeout=1.5, trust_env=False) as c:
            running = (await c.get(url + "/models")).status_code == 200
    except httpx.HTTPError:
        pass
    p = _llm["proc"]
    ours = bool(p and p.poll() is None)
    tail = ""
    if LLM_LOG.exists():
        lines = [ln for ln in LLM_LOG.read_text("utf-8", "ignore").splitlines() if ln.strip()]
        tail = "\n".join(lines[-3:])[-400:]
    exited = p.returncode if p and not ours else None
    return {"script": LLM_SCRIPT.exists(), "url": url, "running": running, "starting": ours and not running,
            "ours": ours, "exit_code": exited, "log": tail}


@app.post("/api/llm/local")
async def local_llm_action(body: dict = Body(...)):
    act = body.get("action")
    if act == "start":
        st = await local_llm_status()
        if st["running"] or st["ours"]:
            return st
        if not LLM_SCRIPT.exists():
            raise HTTPException(400, f"找不到启动脚本 {LLM_SCRIPT}")
        port = re.search(r":(\d+)", _local_url().split("//", 1)[-1])
        env = {**os.environ, "PORT": port.group(1) if port else "8090"}
        log_f = open(LLM_LOG, "w")
        _llm["proc"] = subprocess.Popen(["bash", str(LLM_SCRIPT)], stdout=log_f, stderr=subprocess.STDOUT,
                                        stdin=subprocess.DEVNULL, env=env, start_new_session=True)
        log_f.close()
        log.info("local llm started pid=%s", _llm["proc"].pid)
        await asyncio.sleep(1)
    elif act == "stop":
        p = _llm["proc"]
        if not (p and p.poll() is None):
            raise HTTPException(400, "本地模型不是从这里启动的，请在启动它的终端里按 Ctrl+C 关闭")
        await asyncio.to_thread(_stop_local_llm)
    else:
        raise HTTPException(400, "未知操作")
    return await local_llm_status()


# ---------------- 搜索 ----------------
@app.get("/api/search")
def search(q: str = ""):
    """按标题、转写、笔记、纪要搜索，返回每条记录的命中数和一小段上下文。"""
    q = q.strip()
    if not q:
        return []
    ql = q.lower()
    out = []
    for m in store.list_all():
        mid = m["id"]
        texts = [p["text"] for p in _paras(mid)] + [_notes(mid), (store.load(mid, "minutes.json") or {}).get("markdown", "")]
        hits, snip = 0, ""
        for t in texts:
            tl = t.lower()
            n = tl.count(ql)
            if n and not snip:
                i = tl.find(ql)
                snip = ("…" if i > 18 else "") + t[max(0, i - 18): i + len(q) + 30].replace("\n", " ")
            hits += n
        if hits or ql in m["title"].lower():
            out.append({"id": mid, "hits": hits, "snippet": snip})
    return out


# ---------------- 每日汇总 ----------------
def _check_date(date: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    return date


def _day_meetings(date: str) -> list[dict]:
    return sorted((m for m in store.list_all() if m["created"][:10] == date), key=lambda m: m["created"])


def _wall(meta: dict, segmap: list | None, ms: int) -> float:
    """对话内时间 → 墙钟（自动记录压缩了静音，用分段映射还原）。"""
    if segmap:
        base = segmap[0]
        for s in segmap:
            if s[0] <= ms:
                base = s
            else:
                break
        return base[1] + (ms - base[0]) / 1000
    t0 = meta.get("started_at") or meta["created"]
    return datetime.fromisoformat(t0).timestamp() + ms / 1000


def _hm(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def _day_blocks(metas: list[dict]) -> list[str]:
    blocks = []
    for m in metas:
        if m["status"] == "recording" and m.get("source") != "ambient":
            continue
        paras = _paras(m["id"])
        if not paras:
            continue
        seg = store.load(m["id"], "segmap.json")
        t0, t1 = _wall(m, seg, paras[0]["start"]), _wall(m, seg, paras[-1]["end"])
        kind = "自动记录" if m.get("source") == "ambient" else ("上传录音" if m.get("source") == "upload" else "会议")
        nspk = len({p["spk"] for p in paras if p["spk"] >= 0})
        head = f"### [{_hm(t0)}–{_hm(t1)}] {m['title']}（{kind}{f'，{nspk} 人' if nspk else ''}）"
        mrec = store.load(m["id"], "minutes.json") or {}
        # 纪要生成后转写改过（改名、改字、续录）的话用转写，免得汇总里是旧名字、漏内容
        mn = "" if "transcript" in _minutes_stale(m["id"], m, mrec) else mrec.get("markdown", "")
        if mn:
            body = "（已整理的纪要）\n" + mn
        else:
            body = "\n".join(f"[{_hm(_wall(m, seg, p['start']))}] {prompts.spk_name(m, p['spk']) if p['spk'] >= 0 else ''}："
                             f"{p['text']}" for p in paras)
        notes = _notes(m["id"]).strip()
        blocks.append(head + ("\n用户笔记：" + notes if notes else "") + "\n" + body)
    return blocks


async def daily_gen(date: str, prov: dict):
    t0 = time.time()
    metas = _day_meetings(date)
    blocks = _day_blocks(metas)
    if not blocks:
        yield _ndjson({"type": "error", "msg": "这一天没有可汇总的转写内容"})
        return
    src_hash = _hash("\n\n".join(blocks))
    budget = int(prov.get("max_input_chars") or 60000) - 3000
    out = ""
    try:
        if sum(len(b) + 2 for b in blocks) > budget:
            per = max(400, int(budget * 0.9 / len(blocks)))
            new = []
            for i, b in enumerate(blocks, 1):
                if len(b) <= per:
                    new.append(b)
                    continue
                yield _ndjson({"type": "status", "msg": f"内容较多，正在逐段提炼 {i}/{len(blocks)}…"})
                head, *lines = b.split("\n")
                chunks = prompts.chunk_lines(lines, int(budget * 0.8))
                parts = []
                for ch in chunks:
                    parts.append(await chat(prov, [{"role": "user", "content": prompts.DAY_MAP_PROMPT.format(
                        n=max(150, per // len(chunks)), text=head + "\n" + "\n".join(ch))}], max_tokens=1500))
                new.append(head + "\n" + "\n".join(p.strip() for p in parts))
            blocks = new
        d = datetime.strptime(date, "%Y-%m-%d")
        label = f"{d.month}月{d.day}日 周{'一二三四五六日'[d.weekday()]}"
        msgs = prompts.daily_messages(label, vocab.hotwords(), blocks)
        yield _ndjson({"type": "status", "msg": f"{prov['name']} 生成中…"})
        async for delta in chat_stream(prov, msgs, max_tokens=4000):
            out += delta
            yield _ndjson({"type": "delta", "text": delta})
        rec = {"markdown": out.strip(), "provider": prov["name"], "model": prov["model"],
               "created": datetime.now().isoformat(timespec="seconds"), "cost": round(time.time() - t0, 1),
               "meetings": [m["id"] for m in metas], "src_hash": src_hash}
        DAILY.mkdir(parents=True, exist_ok=True)
        store.write_json(DAILY / f"{date}.json", rec)
        (DAILY / f"{date}.auto.json").unlink(missing_ok=True)  # 生成成功就清掉之前自动汇总的失败记录
        yield _ndjson({"type": "done", "summary": rec})
    except LLMError as e:
        yield _ndjson({"type": "error", "msg": str(e)})
    except Exception as e:  # noqa: BLE001
        log.exception("daily")
        yield _ndjson({"type": "error", "msg": f"{type(e).__name__}: {e}"})


@app.get("/api/days/{date}")
def get_day(date: str):
    _check_date(date)
    metas = _day_meetings(date)
    for m in metas:
        seg = store.load(m["id"], "segmap.json")
        m["clock_start"] = _hm(_wall(m, seg, 0))
        m["clock_end"] = (m.get("ended_at") or "")[11:16] or _hm(_wall(m, None, int(m.get("duration", 0) * 1000)))
    sm = store.read_json(DAILY / f"{date}.json")
    stale = None
    if sm and sm.get("src_hash"):
        # 汇总生成后：新增了记录，或者已有记录的文字、说话人名、纪要有改动
        new = [m["id"] for m in metas if m["id"] not in set(sm.get("meetings") or [])]
        changed = sm["src_hash"] != _hash("\n\n".join(_day_blocks(metas)))
        if new or changed:
            stale = {"new": len(new), "changed": changed}
    return {"date": date, "meetings": metas, "summary": sm, "summary_stale": stale,
            "auto_error": store.read_json(DAILY / f"{date}.auto.json")}


@app.post("/api/days/{date}/summary")
async def day_summary(date: str, body: dict = Body(default={})):
    _check_date(date)
    prov = _prov(body.get("provider"))
    return StreamingResponse(daily_gen(date, prov), media_type="application/x-ndjson")


async def _housekeeping():
    """每分钟：到点自动生成当日汇总；每小时：清理过期的自动记录录音。
    自动汇总：到点后生成一次。到点前手动生成过、之后又有新内容的，到点再重新生成；
    没配 Key 时每分钟再看一次（配好后自动补上）；接口出错隔 30 分钟重试，最多 3 次。失败原因写进 daily/<日期>.auto.json，当日页面显示。"""
    auto: dict[str, dict] = {}  # 日期 → {"tries", "next", "done"}
    last_purge = 0.0
    while True:
        await asyncio.sleep(60)
        try:
            cfg = ambient.cfg
            if time.time() - last_purge > 3600:
                last_purge = time.time()
                n = await asyncio.to_thread(purge_old_audio, int(cfg.get("audio_keep_days") or 0))
                if n:
                    log.info("purged audio of %d old ambient recordings", n)
            st = (cfg.get("summary_time") or "").strip()
            if not cfg.get("enabled") or not re.fullmatch(r"\d{1,2}:\d{2}", st):
                continue
            now = datetime.now()
            date = now.strftime("%Y-%m-%d")
            h, mi = map(int, st.split(":"))
            s = auto.setdefault(date, {"tries": 0, "next": 0.0, "done": False})
            if (now.hour, now.minute) < (h, mi) or s["done"] or time.time() < s["next"]:
                continue
            rec = store.read_json(DAILY / f"{date}.json")
            due = now.replace(hour=h, minute=mi, second=0, microsecond=0).timestamp()
            if rec and datetime.fromisoformat(rec["created"]).timestamp() >= due:
                s["done"] = True  # 到点后已经生成过（自动或手动）
                continue
            metas = _day_meetings(date)
            if not metas:
                continue
            if any(m["status"] in ("recording", "queued", "transcribing") for m in metas) and (now.hour, now.minute) < (23, 40):
                continue  # 等正在记录/转写的结束，否则汇总里是临时文字、还会漏掉后半段
            if rec and rec.get("src_hash") == _hash("\n\n".join(_day_blocks(metas))):
                s["done"] = True  # 早先手动生成的汇总已经包含全部内容
                continue
            try:
                prov = store.provider()
                if not prov.get("api_key"):
                    raise KeyError(f"当前选中的模型「{prov['name']}」没有配置 API Key")
            except KeyError as e:
                _auto_fail(date, e.args[0] + "（配好后会自动补上）", 0)
                s["next"] = time.time() + 60
                continue
            err = ""
            async for line in daily_gen(date, prov):
                j = json.loads(line)
                if j.get("type") == "error":
                    err = j["msg"]
            if err:
                s["tries"] += 1
                s["done"] = s["tries"] >= 3
                s["next"] = time.time() + 1800
                _auto_fail(date, err, s["tries"], final=s["done"])
                log.warning("auto daily summary %s failed (%d): %s", date, s["tries"], err)
            else:
                s["done"] = True
                log.info("auto daily summary for %s finished", date)
        except Exception:  # noqa: BLE001
            log.exception("housekeeping")


def _auto_fail(date: str, msg: str, tries: int, final: bool = False):
    DAILY.mkdir(parents=True, exist_ok=True)
    store.write_json(DAILY / f"{date}.auto.json", {"at": datetime.now().isoformat(timespec="seconds"), "error": msg[:300],
                                                  "tries": tries, "final": final})


app.mount("/static", StaticFiles(directory=store.BASE / "static"), name="static")
