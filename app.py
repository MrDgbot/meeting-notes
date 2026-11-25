"""会议记录本地服务。

启动:  ./start.sh  →  http://127.0.0.1:8770
"""
import asyncio
import contextlib
import copy
import hashlib
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import threading
import tempfile
import time
import zipfile
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from starlette.background import BackgroundTask
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import insights
import lan
import llm
import marks as marks_mod
import meeting_state as ms
import minutes_check
import prompts
import relations
import rsi_ambient
import rsi_events
import rsi_vocab
import store
import vocab
import voiceprints
from ambient import STATES as AMBIENT_STATES, TRANSITIONS as AMBIENT_TRANSITIONS
from ambient import (SENS, Ambient, has_user_content as ambient_has_user_content, list_devices, purge_candidates,
                     purge_old_audio, save_cfg as save_ambient_cfg, sens_thres, skips_from_segmap, storage_estimate)
import waveform
import dual_audio
from asr_engine import (ASR_MODELS, DEVICE, DIARIZERS, Engine, asr_mode, diarizer_mode, duration_of, fmt_ts, make_mp3,
                        pcm_to_wav, to_wav16k)
from llm import LLMError, chat, chat_events, chat_stream

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = FastAPI(title="会议记录")
app.add_middleware(lan.Guard)  # 不是从本机来的请求（局域网里的平板、手机）要先用访问口令登录
app.include_router(lan.router)
lan.server.app = app
engine = Engine()
jobs = ThreadPoolExecutor(max_workers=1)
minutes_jobs = ThreadPoolExecutor(max_workers=2)
MODEL_FAIL = "语音模型加载失败"


def is_live_active(mid: str) -> bool:
    return mid in LIVE


def invalidate_derived_caches(mid: str | None = None, *, vocab_changed: bool = False) -> None:
    if vocab_changed:
        vocab.invalidate()
    with _suspect_lock:
        if mid is None:
            _suspect_cache.clear()
        else:
            _suspect_cache.pop(mid, None)
    with _search_lock:
        if mid is None:
            _search_cache.clear()
        else:
            _search_cache.pop(mid, None)


def _active_prov_optional(pid: str | None = None) -> dict | None:
    try:
        return store.provider(pid)
    except KeyError:
        return None


def _friendly_error(exc: Exception, default: str = "操作未完成，请稍后重试") -> str:
    if isinstance(exc, LLMError):
        return str(exc)
    raw = str(exc or "").strip()
    lower = raw.lower()
    if "no space left" in lower or "disk full" in lower:
        return "磁盘空间不足，请清理空间后再试"
    if "permission denied" in lower or isinstance(exc, PermissionError):
        return "缺少读取或写入权限，请检查系统权限设置"
    if "ffmpeg" in lower:
        return "音频解码失败，请确认文件未损坏且格式受支持"
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)) or "timed out" in lower:
        return "处理超时，请稍后再试"
    if not raw:
        return default
    # 剥离 Python 内部异常类名前缀
    cleaned = re.sub(r"^[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):\s*", "", raw).strip()
    return (cleaned or default)[:240]


def _run_refresh_minutes(mid: str) -> None:
    try:
        refresh_minutes_after_transcript(mid)
    except Exception:  # noqa: BLE001
        log.exception("auto minutes %s", mid)
    try:
        meta = store.get(mid)
        if (
            meta
            and meta.get("status") == ms.READY
            and not rsi_events.is_excluded(meta)
            and not meta.get("brief")
            and sum(len(str(p.get("text") or "")) for p in _paras(mid)) >= 40
        ):
            asyncio.run(insights.generate_brief(mid, _active_prov_optional()))
            invalidate_derived_caches(mid)
    except Exception:  # noqa: BLE001
        log.debug("auto brief %s failed", mid, exc_info=True)


# ---------------- 后台转写 ----------------
def run_transcribe(mid: str):
    released = False

    def release():  # 只放开自己这一轮的占位，不误放后来排进来的下一轮
        nonlocal released
        if not released:
            released = True
            with _inflight_lock:
                _inflight.discard(mid)

    wav: Path | None = None
    mp3: Path | None = None
    from_mp3 = False
    try:
        d = store.mdir(mid)
        meta = store.get(mid)
        if meta is None:
            return
        wav = d / "audio.wav"
        mp3 = d / "audio.mp3"
        # 先把原始录音转成 wav：后面就算模型出错，网页上也能播放录音、点“重新转写”
        if (d / "audio.pcm").exists() and (not wav.exists() or (d / "audio.pcm").stat().st_mtime > wav.stat().st_mtime):
            pcm_to_wav(d / "audio.pcm", wav, meta.get("audio_channels") or 1)
        if not wav.exists() and mp3.exists():  # 自动记录转写后只保留 mp3
            to_wav16k(mp3, wav)
            from_mp3 = True
        while not engine.ready:
            if engine.error and not engine.loading:
                raise RuntimeError(f"{MODEL_FAIL}: " + engine.error)
            time.sleep(1)
        dur = duration_of(wav)
        ms.transition(mid, ms.TRANSCRIBING, reason="job_start", duration=dur, error="", job_started=time.time(),
                      job_estimate=max(5.0, dur / {"nano": 4, "doubao": 10}.get(asr_mode(), 6) + (8 if asr_mode() == "doubao" else 3)
                                       + (dur * 0.08 + 20 if diarizer_mode() == "pyannote" else 0)
                                       + (dur * 0.2 + 40 if diarizer_mode() == "nemotron" else 0)))  # nemotron 含首次下载，时间按保守值估
        # wav 是从 mp3 解出来的就不要再压回去：mp3 有损，每次重新转写都重压一遍，几次后音质明显变差
        if not from_mp3 and (not mp3.exists() or mp3.stat().st_mtime < wav.stat().st_mtime):
            make_mp3(wav, mp3)
        t = time.time()
        vad_kw = {"speech_noise_thres": sens_thres()} if meta.get("source") == "ambient" else None
        paras = engine.transcribe(wav, meta.get("num_spk", 0), _meeting_hotwords(mid, meta), vad_kw)
        cost = time.time() - t
        spk_embs = getattr(engine, "last_spk_embs", None)
        if spk_embs and spk_embs.get("speakers"):
            try:
                store.save(mid, "spk_embs.json", spk_embs)
            except Exception:  # noqa: BLE001
                log.debug("save spk_embs failed %s", mid, exc_info=True)
        if any(p.get("ch") is not None for p in paras):
            with store.locked():
                fresh = store.get(mid) or {}
                existing = fresh.get("speakers") or {}
                names = dual_audio.suggest_channel_names(paras, existing)
                if names != existing:
                    store.update(mid, speakers=names)
        store.save(mid, "transcript.json", {"paragraphs": paras, "device": DEVICE, "cost": round(cost, 1),
                                            "asr": engine.last_info,
                                            "num_spk_requested": meta.get("num_spk", 0),
                                            "created": datetime.now().isoformat(timespec="seconds")})
        try:
            fresh_meta = store.get(mid) or meta
            clear_smeta = False
            if rsi_events.is_excluded(fresh_meta):
                clear_smeta = True
            else:
                rsi_vocab.record_hits(paras, vocab.get()["fixes"])
                if spk_embs and spk_embs.get("speakers"):
                    cfg_rsi = rsi_events.get_config()
                    matched = voiceprints.match_meeting(spk_embs, auto_name=bool(cfg_rsi.get("auto_name", True)))
                    applied_auto: dict = {}
                    with store.locked():
                        cur_meta = store.get(mid) or {}
                        cur_speakers = dict(cur_meta.get("speakers") or {})
                        for spk_k, info in (matched.get("auto") or {}).items():
                            if not (cur_speakers.get(spk_k) or "").strip():
                                cur_speakers[spk_k] = info["name"]
                                applied_auto[spk_k] = {**info, "source": "voiceprint_auto"}
                        speaker_meta = {
                            "auto": applied_auto,
                            "suggest": matched.get("suggest") or {},
                            "merge_hints": matched.get("merge_hints") or [],
                        }
                        upd: dict = {"speaker_meta": speaker_meta}
                        if applied_auto:
                            upd["speakers"] = cur_speakers
                        store.update(mid, **upd)
                    if applied_auto:
                        voiceprints.record_auto_named(mid)
                else:
                    clear_smeta = True
            if clear_smeta:
                with store.locked():
                    cur_meta = store.get(mid)
                    if cur_meta and "speaker_meta" in cur_meta:
                        cur_meta.pop("speaker_meta", None)
                        store.write_json(store.mdir(mid) / "meta.json", cur_meta)
                        store._invalidate_meta(mid)
        except Exception:  # noqa: BLE001
            log.debug("rsi post-transcribe hook failed %s", mid, exc_info=True)
        n = len({p["spk"] for p in paras})
        ms.transition(mid, ms.READY, reason="transcribed", num_speakers=n, transcribe_cost=round(cost, 1),
                      chars=sum(len(p["text"]) for p in paras))
        if meta.get("source") == "ambient":  # 全天记录量大：确认 mp3 有效后才删原始 pcm/wav，防止编码失败丢录音
            if mp3.exists() and mp3.stat().st_size > 0:
                (d / "audio.pcm").unlink(missing_ok=True)
                wav.unlink(missing_ok=True)
            else:
                log.warning("transcribed %s: skip deleting pcm/wav because audio.mp3 is missing or empty", mid)
        release()  # 转写和文件清理都已完成：后面自动刷新纪要期间允许再排队
        log.info("transcribed %s: %.0fs audio in %.1fs, %d speakers", mid, dur, cost, n)
        try:
            minutes_jobs.submit(_run_refresh_minutes, mid)
        except RuntimeError:  # 服务正在关闭，executor 已 shutdown
            pass
    except Exception as e:  # noqa: BLE001
        log.exception("transcribe failed %s", mid)
        try:
            ms.transition(mid, ms.ERROR, reason="job_failed", error=str(e)[:500])
        except Exception:  # noqa: BLE001
            pass
    finally:
        if from_mp3 and wav is not None and mp3 is not None and mp3.exists() and mp3.stat().st_size > 0:
            wav.unlink(missing_ok=True)
        release()


# 已经交给转写线程、还没跑完的会议。同一场只排一次：网页连点两下“重新转写”、
# 自动收尾和卡住检测同时触发时，以前会把同一段录音转写两遍。
_inflight: set[str] = set()
_inflight_lock = threading.Lock()


def _is_transcribe_inflight(mid: str) -> bool:
    with _inflight_lock:
        return mid in _inflight


def queue_transcribe(mid: str, reason: str = "queue"):
    with _inflight_lock:
        if mid in _inflight:
            log.info("transcribe %s already queued, skip duplicate (%s)", mid, reason)
            return
        _inflight.add(mid)
    try:
        ms.transition(mid, ms.QUEUED, reason=reason, error="")
        jobs.submit(run_transcribe, mid)
    except BaseException:
        with _inflight_lock:
            _inflight.discard(mid)
        raise


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
    store.purge_discarded()  # 回收站里超过 7 天的短对话
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
        if m["status"] in ms.ACTIVE:
            d = store.mdir(m["id"])
            if (d / "audio.pcm").exists() or (d / "audio.wav").exists() or (d / "audio.mp3").exists():
                queue_transcribe(m["id"])
            else:
                ms.transition(m["id"], ms.NEW, reason="restart_no_audio")
    if ambient.cfg.get("enabled"):
        ambient.start(restore=True)  # 等语音模型就绪后自动开始采集；上次暂停着的话继续暂停
    asyncio.get_running_loop().create_task(_housekeeping())
    asyncio.get_running_loop().create_task(lan.server.apply())  # 开着局域网访问的话，另起 HTTPS 端口


@app.on_event("shutdown")
async def _shutdown():
    await lan.server.stop()
    ambient.shutdown()
    _stop_local_llm()
    if hasattr(jobs, "shutdown"):
        jobs.shutdown(wait=False, cancel_futures=True)
    if hasattr(minutes_jobs, "shutdown"):
        minutes_jobs.shutdown(wait=False, cancel_futures=True)


# ---------------- 基础 ----------------
def _static_ver(st: Path, name: str) -> int:
    ver = int((st / name).stat().st_mtime)
    if name == "app.js" and (st / "js").is_dir():
        for p in (st / "js").glob("*.js"):
            with contextlib.suppress(OSError):
                ver = max(ver, int(p.stat().st_mtime))
    return ver


_STATIC_ASSET_RE = re.compile(r'/static/([^"?]+\.(?:js|css))"')


@app.get("/")
def index():
    st = store.BASE / "static"
    html = (st / "index.html").read_text("utf-8")

    def _bust(m: re.Match) -> str:
        name = m.group(1)
        if not (st / name).is_file():
            return m.group(0)
        return f'/static/{name}?v={_static_ver(st, name)}"'

    html = _STATIC_ASSET_RE.sub(_bust, html)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health(request: Request):
    note = ""
    if engine.nano_loading:
        note = "正在加载 Fun-ASR-Nano（约 15 秒），这期间实时文字会暂停"
    elif engine.nano_error and asr_mode() in ("nano", "doubao"):
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
    import doubao_asr
    return {"model": asr_mode(), "options": asr_options(), "nano_loaded": engine.nano is not None,
            "nano_loading": engine.nano_loading, "nano_error": engine.nano_error,
            "diarizer": diarizer_mode(), "diarizers": DIARIZERS,
            "doubao_ddc": doubao_asr.ddc_enabled()}


def asr_options() -> dict:
    """云端识别要有本机配置（data/doubao.json，见 doubao_asr.config）才出现在选项里；当前已选中的照常显示。"""
    import doubao_asr
    return {k: v for k, v in ASR_MODELS.items() if k != "doubao" or k == asr_mode() or doubao_asr.config()}


@app.put("/api/asr")
def put_asr(body: dict = Body(...)):
    """body：{"model": 识别模型}、{"diarizer": 说话人分离方式}、{"doubao_ddc": 豆包语义顺滑}。"""
    m = body.get("model")
    with store.locked():
        s = store.get_settings()
        asr = {**(s.get("asr") or {})}
        if "diarizer" in body:
            if body["diarizer"] not in DIARIZERS:
                raise HTTPException(400, "未知的说话人分离方式")
            asr["diarizer"] = body["diarizer"]
        if "doubao_ddc" in body:
            asr["doubao_ddc"] = bool(body["doubao_ddc"])
        if "model" in body:
            if m not in asr_options():
                raise HTTPException(400, "未知的识别模型")
            asr["model"] = m
        elif "diarizer" not in body and "doubao_ddc" not in body:
            raise HTTPException(400, "未知的识别模型")
        s["asr"] = asr
        store.save_settings(s)
    if "model" in body and engine.ready:  # 后台预加载；nano_loading 统一在 engine.load_lock 内维护
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


def _minutes_stale(mid: str, meta: dict, mn: dict | None = None, *,
                   paras: list[dict] | None = None, notes: str | None = None) -> list[str]:
    """纪要生成后，转写（改字、改说话人名、纠错规则、重新转写、续录）或笔记有没有变。
    返回变了的部分：transcript / notes；旧版生成的纪要没有记录来源，不判断。"""
    mn = mn if mn is not None else store.load(mid, "minutes.json")
    if not mn or not mn.get("src_hash"):
        return []
    out = []
    ps = paras if paras is not None else _paras(mid)
    if mn["src_hash"] != _hash("\n".join(prompts.transcript_lines(meta, ps))):
        out.append("transcript")
    if mn.get("notes_hash") is not None:
        nt = notes if notes is not None else _notes(mid)
        if mn["notes_hash"] != _hash(nt.strip()):
            out.append("notes")
    return out


@app.get("/api/meetings")
def list_meetings():
    return store.list_all()


@app.post("/api/meetings")
def create_meeting(body: dict = Body(default={})):
    raw_spk = body.get("num_spk")
    if isinstance(raw_spk, bool):
        raise HTTPException(400, "参会人数应为 0 或正整数")
    try:
        num_spk = int(raw_spk or 0)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "参会人数应为 0 或正整数") from e
    if num_spk < 0:
        raise HTTPException(400, "参会人数应为 0 或正整数")
    return store.create(
        title=str(body.get("title") or ""),
        num_spk=num_spk,
        hotword=str(body.get("hotword") or ""),
        template=str(body.get("template") or "general"),
        source="mic",
    )


@app.post("/api/meetings/upload")
def upload_meeting(file: UploadFile = File(...), title: str = Form(""), num_spk: int = Form(0),
                   hotword: str = Form(""), template: str = Form("general")):
    name = file.filename or "录音"
    stem = re.sub(r"\.[^.]+$", "", Path(name).name).strip()
    init_title = title.strip()
    if not init_title and not store.is_generic_upload_name(stem):
        init_title = stem
    meta = store.create(title=init_title,
                        num_spk=max(0, int(num_spk or 0)), hotword=hotword,
                        template=template, source="upload", filename=name)
    d = store.mdir(meta["id"])
    suffix = Path(name).suffix
    ext = suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix) else ".bin"
    raw = d / ("upload" + ext)
    try:
        with open(raw, "wb") as f:
            while chunk := file.file.read(1 << 20):
                f.write(chunk)
        to_wav16k(raw, d / "audio.wav")
    except Exception as e:  # noqa: BLE001  解码失败、没装 ffmpeg、磁盘满……都不要留下一条空会议
        store.delete(meta["id"])
        raise HTTPException(400, _friendly_error(e, "音频格式不支持或文件已损坏")) from e
    finally:
        raw.unlink(missing_ok=True)
    queue_transcribe(meta["id"])
    return store.get(meta["id"])


@app.get("/api/meetings/{mid}")
def get_meeting(mid: str):
    meta = _meta_or_404(mid)
    d = store.mdir(mid)
    c = ambient.conv
    active = bool(is_live_active(mid) or (c and c.mid == mid))
    mn = store.load(mid, "minutes.json")
    marks = marks_mod.load(mid)
    tr = _fixed_transcript(mid)
    live_paras = vocab.apply_paras(store.load(mid, "live.json", []))
    if tr is not None:
        paras = tr.get("paragraphs") or []
    else:
        paras = [{"spk": 0, "start": x["start"], "end": x["end"], "text": x["text"]} for x in live_paras]
    notes_text = _notes(mid)
    mpar = paras if marks else []
    return {
        "meta": meta,
        "transcript": tr,
        "live": live_paras,
        "segmap": store.load(mid, "segmap.json"),
        "skips": _skips(mid, meta),
        "minutes": _with_marked(mn, marks),
        "marks": [dict(m, snippet=marks_mod.snippet(mpar, m["t_ms"])) for m in marks],
        "minutes_stale": _minutes_stale(mid, meta, mn, paras=paras, notes=notes_text),
        "suspects": _suspects(mid, meta, tr=tr),
        "notes": notes_text,
        "qa": store.load(mid, "qa.json", []),
        # 只剩原始 pcm（转写前就出错）也算有录音：能播放（按需转 wav）、能重新转写
        "has_audio": (d / "audio.mp3").exists() or (d / "audio.wav").exists() or ((d / "audio.pcm").exists() and not active),
        "live_active": is_live_active(mid),
        "live_state": _live_state(mid),
        "ambient_active": bool(c and c.mid == mid),
    }


def _with_marked(mn: dict | None, marks: list[dict]) -> dict | None:
    """给纪要里的要点标上「附近有打点」。老纪要没有 highlights，原样返回。"""
    if not isinstance(mn, dict) or not isinstance(mn.get("highlights"), list):
        return mn
    hl = [dict(h, marked=bool(marks_mod.near(marks, h.get("start_ms"), h.get("end_ms")))) for h in mn["highlights"]
          if isinstance(h, dict)]
    return dict(mn, highlights=hl)


@app.post("/api/meetings/{mid}/marks")
def add_mark(mid: str, body: dict = Body(...)):
    """录音时一键打点：记下当前的音频时间。"""
    _meta_or_404(mid)
    try:
        raw_t = body.get("t_ms")
        if isinstance(raw_t, bool):
            raise TypeError("bool")
        t_ms = int(raw_t)
        mark, marks, created = marks_mod.add(mid, t_ms, str(body.get("label") or ""))
    except (TypeError, ValueError, OverflowError) as e:
        raise HTTPException(400, str(e) if isinstance(e, ValueError) and "最多" in str(e) else "标记时间格式不正确") from e
    return {"mark": mark, "marks": marks, "created": created}


@app.delete("/api/meetings/{mid}/marks/{mark_id}")
def delete_mark(mid: str, mark_id: str):
    _meta_or_404(mid)
    try:
        deleted = next((m for m in marks_mod.load(mid) if m["id"] == mark_id), None)
        return {"marks": marks_mod.remove(mid, mark_id), "deleted": deleted}
    except KeyError:
        raise HTTPException(404, "没有这个打点") from None


def _fixed_transcript(mid: str) -> dict | None:
    tr = store.load(mid, "transcript.json")
    if tr and tr.get("paragraphs"):
        tr["paragraphs"] = vocab.apply_paras(tr["paragraphs"])
    return tr


_suspect_lock = threading.Lock()
_suspect_cache: OrderedDict[str, tuple[tuple, list[dict]]] = OrderedDict()
_SUSPECT_CACHE_MAX = 200


def _suspects(mid: str, meta: dict, *, tr: dict | None = None) -> list[dict]:
    """转写里疑似认错的热词（只给建议）。页面会反复读会议详情，按转写、词库、本场热词有没有变来缓存。"""
    f, v = store.mdir(mid) / "transcript.json", vocab.PATH
    if not f.exists():
        return []
    fst = f.stat()
    vst = v.stat() if v.exists() else None
    rsi_sig = None
    try:
        rsi_sig = rsi_vocab.stats_sig()
    except Exception:  # noqa: BLE001
        pass
    key = (fst.st_mtime_ns, fst.st_size, vst.st_mtime_ns if vst else 0, vst.st_size if vst else 0, meta.get("hotword", ""), rsi_sig)
    with _suspect_lock:
        hit = _suspect_cache.get(mid)
        if hit and hit[0] == key:
            _suspect_cache.move_to_end(mid)
            return hit[1]
    try:
        use_tr = tr if tr is not None else _fixed_transcript(mid)
        res = vocab.suspects((use_tr or {}).get("paragraphs") or [], meta.get("hotword", ""))
    except Exception:  # noqa: BLE001  建议功能出错不能影响打开会议
        log.exception("suspects")
        res = []
    with _suspect_lock:
        _suspect_cache[mid] = (key, res)
        _suspect_cache.move_to_end(mid)
        while len(_suspect_cache) > _SUSPECT_CACHE_MAX:
            _suspect_cache.popitem(last=False)
    return res


def _ambient_busy(mid: str) -> bool:
    """全天模式正在写这段对话，或者刚切段还在队列里等收尾。"""
    with ambient.lock:
        c = ambient.conv
        return (c is not None and c.mid == mid) or (mid in ambient._pending_close)


@app.put("/api/meetings/{mid}/paragraphs/{i}")
def edit_paragraph(mid: str, i: int, body: dict = Body(...)):
    """手动修改一段转写：text（空字符串 = 删除这段）、spk（改说话人）。重新转写会覆盖手动修改。"""
    meta = _meta_or_404(mid)
    if meta["status"] in ms.BUSY or is_live_active(mid) or _ambient_busy(mid):
        raise HTTPException(409, "正在记录或处理中，结束后再修改")
    spk_val = None
    if "spk" in body:
        if isinstance(body["spk"], bool):
            raise HTTPException(400, "说话人编号不合法")
        try:
            spk_val = int(body["spk"])
        except (TypeError, ValueError) as e:
            raise HTTPException(400, "说话人编号不合法") from e
        if spk_val < 0:
            raise HTTPException(400, "说话人编号不合法")
    orig_text = ""
    pre_edit_text = ""
    edited_text: str | None = None
    with store.locked():
        tr = store.load(mid, "transcript.json")
        if tr is not None:
            ps, name = tr.setdefault("paragraphs", []), "transcript.json"
        else:
            ps, name = store.load(mid, "live.json", []), "live.json"
        if not 0 <= i < len(ps):
            raise HTTPException(404, "段落不存在")
        text = str(body["text"] or "").strip() if "text" in body else None
        if text == "":
            ps.pop(i)
        else:
            if text is not None:
                raw_before = ps[i].get("text") or ""
                was_edited = bool(ps[i].get("edited"))
                if "orig_text" not in ps[i]:
                    ps[i]["orig_text"] = raw_before
                orig_text = str(ps[i].get("orig_text") or raw_before)
                pre_edit_text = raw_before if was_edited else vocab.apply(raw_before)
                edited_text = text
                ps[i].update(text=text, edited=True)
            if spk_val is not None and tr is not None:
                ps[i].update(spk=spk_val, edited=True)
        store.save(mid, name, tr if tr is not None else ps)
        if tr is not None:
            store.update(mid, num_speakers=len({p["spk"] for p in ps}), chars=sum(len(p.get("text") or "") for p in ps))
    if edited_text is not None:
        try:
            if not rsi_events.is_excluded(meta):
                res = rsi_vocab.record_edit(mid, orig_text, pre_edit_text, edited_text, vocab.get()["fixes"])
                if res.get("demoted"):
                    invalidate_derived_caches(vocab_changed=True)
        except Exception:  # noqa: BLE001
            log.debug("rsi_vocab record_edit failed %s", mid, exc_info=True)
    return get_meeting(mid)


@app.get("/api/vocab")
def get_vocab():
    return vocab.get()


@app.put("/api/vocab")
def put_vocab(body: dict = Body(...)):
    res = vocab.save(body)
    invalidate_derived_caches(vocab_changed=True)
    return res


@app.post("/api/vocab/fix")
def add_vocab_fix(body: dict = Body(...)):
    a, b = (body.get("from") or "").strip(), (body.get("to") or "").strip()
    if not a or a == b:
        raise HTTPException(400, "规则不完整")
    res = vocab.add_fix(a, b, bool(body.get("hotword")))
    invalidate_derived_caches(vocab_changed=True)
    return res


def _clean_speaker_meta(old_speakers: dict, new_speakers: dict, old_smeta: dict) -> tuple[dict, bool]:
    if not isinstance(old_smeta, dict) or not old_smeta:
        return {}, False
    new_smeta = copy.deepcopy(old_smeta)
    mutated = False
    changed_spks = {
        spk_k
        for spk_k in (set(old_speakers) | set(new_speakers))
        if (new_speakers.get(spk_k) or "").strip() != (old_speakers.get(spk_k) or "").strip()
    }
    if changed_spks:
        if isinstance(new_smeta.get("auto"), dict):
            auto_map = new_smeta["auto"]
            for spk_k in list(auto_map.keys()):
                if spk_k in changed_spks:
                    auto_map.pop(spk_k, None)
                    mutated = True
        if isinstance(new_smeta.get("suggest"), dict):
            suggest_map = new_smeta["suggest"]
            for spk_k in changed_spks:
                if spk_k not in suggest_map:
                    continue
                new_n = (new_speakers.get(spk_k) or "").strip()
                old_n = (old_speakers.get(spk_k) or "").strip()
                sug_info = suggest_map.get(spk_k)
                sug_name = str(sug_info.get("name") or "").strip() if isinstance(sug_info, dict) else ""
                if new_n or (old_n and sug_name == old_n):
                    suggest_map.pop(spk_k, None)
                    mutated = True
        if isinstance(new_smeta.get("merge_hints"), list):
            kept_hints = []
            for h in new_smeta["merge_hints"]:
                if isinstance(h, dict):
                    h_spks = {str(x) for x in (h.get("spks") or [])}
                    h_name = str(h.get("name") or "").strip()
                    if any((new_speakers.get(k) or "").strip() != h_name for k in (changed_spks & h_spks)):
                        mutated = True
                        continue
                kept_hints.append(h)
            new_smeta["merge_hints"] = kept_hints
    return new_smeta, mutated


def _update_commitments_speaker(mid: str, old_name: str, new_who: str) -> None:
    items = insights.load_commitments(mid)
    if not items:
        return
    changed = False
    for it in items:
        if str(it.get("who") or "").strip() == old_name:
            it["who"] = new_who
            changed = True
    if changed:
        insights.save_commitments(mid, items)


def _replace_minutes_speaker(mid: str, old_name: str, new_name: str) -> bool:
    if not old_name or not new_name or old_name == new_name:
        return False
    with store.locked():
        mn = store.load(mid, "minutes.json")
        if not isinstance(mn, dict) or not mn.get("markdown"):
            return False
        md_text = str(mn.get("markdown") or "")
        if old_name not in md_text:
            return False
        if "orig_markdown" not in mn:
            mn["orig_markdown"] = md_text
        mn["markdown"] = md_text.replace(old_name, new_name)
        mn["edited"] = True
        store.save(mid, "minutes.json", mn)
        return True


@app.patch("/api/meetings/{mid}")
def patch_meeting(mid: str, body: dict = Body(...)):
    old_meta = _meta_or_404(mid)
    allowed: dict = {}
    if "title" in body:
        if not isinstance(body["title"], str) or not body["title"].strip():
            raise HTTPException(400, "标题不能为空")
        allowed["title"] = body["title"].strip()
        allowed["title_auto"] = False
        allowed["title_source"] = "manual"
    if "num_spk" in body:
        raw_spk = body["num_spk"]
        if isinstance(raw_spk, bool):
            raise HTTPException(400, "参会人数应为 0 或正整数")
        try:
            n = int(raw_spk or 0)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, "参会人数应为 0 或正整数") from e
        if n < 0:
            raise HTTPException(400, "参会人数应为 0 或正整数")
        allowed["num_spk"] = n
    if "hotword" in body:
        if body["hotword"] is not None and not isinstance(body["hotword"], str):
            raise HTTPException(400, "热词格式不正确")
        allowed["hotword"] = body["hotword"] or ""
    if "template" in body:
        if not isinstance(body["template"], str) or not body["template"].strip():
            raise HTTPException(400, "请选择有效的纪要模板")
        allowed["template"] = body["template"].strip()
    if "rsi_exclude" in body:
        if not isinstance(body["rsi_exclude"], bool):
            raise HTTPException(400, "隐私标记参数不正确")
        allowed["rsi_exclude"] = body["rsi_exclude"]
    speakers_changed = False
    old_speakers = dict(old_meta.get("speakers") or {})
    old_smeta = copy.deepcopy(old_meta.get("speaker_meta") or {})
    if "speakers" in body:
        sp = body["speakers"]
        if not isinstance(sp, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in sp.items()):
            raise HTTPException(400, "发言人列表格式不正确")
        allowed["speakers"] = sp
        speakers_changed = True
        new_smeta, mutated_smeta = _clean_speaker_meta(old_speakers, sp, old_smeta)
        if mutated_smeta:
            allowed["speaker_meta"] = new_smeta
    if "notes" in body:
        if not isinstance(body["notes"], str):
            raise HTTPException(400, "笔记内容格式不正确")
        store.write_text(store.mdir(mid) / "notes.md", body["notes"])
    orig_md_for_rsi: str | None = None
    minutes_template_for_rsi = old_meta.get("template") or "general"
    if "minutes_markdown" in body:
        if not isinstance(body["minutes_markdown"], str):
            raise HTTPException(400, "纪要内容格式不正确")
        with store.locked():
            mn = store.load(mid, "minutes.json") or {}
            if "orig_markdown" not in mn and "markdown" in mn:
                mn["orig_markdown"] = mn.get("markdown") or ""
            orig_md_for_rsi = str(mn.get("orig_markdown") or "")
            minutes_template_for_rsi = str(mn.get("template") or minutes_template_for_rsi)
            mn.update(markdown=body["minutes_markdown"], edited=True)
            store.save(mid, "minutes.json", mn)
    updated = store.update(mid, **allowed) if allowed else store.get(mid)
    eff_meta = updated or {**old_meta, **allowed}
    if allowed.get("rsi_exclude") is True:
        try:
            voiceprints.revoke_meeting(mid)
        except Exception:  # noqa: BLE001
            log.debug("voiceprints revoke on rsi_exclude failed %s", mid, exc_info=True)
    if speakers_changed:
        try:
            if not rsi_events.is_excluded(eff_meta):
                new_speakers = allowed["speakers"]
                spk_embs = store.load(mid, "spk_embs.json")
                auto_before = old_smeta.get("auto") if isinstance(old_smeta.get("auto"), dict) else {}
                for spk_k in sorted(set(old_speakers) | set(new_speakers)):
                    old_n = (old_speakers.get(spk_k) or "").strip()
                    new_n = (new_speakers.get(spk_k) or "").strip()
                    if old_n == new_n:
                        continue
                    if spk_k in auto_before:
                        voiceprints.record_override(mid, spk_k, old_n, new_n)
                    if not new_n or voiceprints.is_generic_name(new_n):
                        voiceprints.revoke_meeting(mid, spk_k)
                    elif spk_embs:
                        voiceprints.enroll(mid, spk_k, new_n, spk_embs)
                    elif old_n:
                        voiceprints.revoke_meeting(mid, spk_k)
        except Exception:  # noqa: BLE001
            log.debug("voiceprints hook in patch_meeting failed %s", mid, exc_info=True)
    if orig_md_for_rsi is not None:
        try:
            if not rsi_events.is_excluded(eff_meta):
                stats = rsi_events.minutes_edit_stats(orig_md_for_rsi, body["minutes_markdown"])
                rsi_events.emit("minutes_edit", {"mid": mid, "template": minutes_template_for_rsi, **stats})
        except Exception:  # noqa: BLE001
            log.debug("minutes_edit rsi hook failed %s", mid, exc_info=True)
    return updated


@app.delete("/api/meetings/{mid}")
def delete_meeting(mid: str):
    meta = _meta_or_404(mid)
    if is_live_active(mid):
        raise HTTPException(409, "正在录音，先结束录音")
    is_short_unedited_ambient = False
    try:
        if meta.get("source") == "ambient" and float(meta.get("duration") or 0.0) < 90.0:
            tr = store.load(mid, "transcript.json") or {}
            tr_edited = any(p.get("edited") for p in (tr.get("paragraphs") or []))
            if not tr_edited and not ambient_has_user_content(mid):
                is_short_unedited_ambient = True
    except Exception:  # noqa: BLE001
        pass
    ambient.discard(mid)  # 正在全天记录的这段：停止写入、不转写
    store.delete(mid)
    try:
        voiceprints.revoke_meeting(mid)
    except Exception:  # noqa: BLE001
        log.debug("voiceprints revoke on delete failed %s", mid, exc_info=True)
    if is_short_unedited_ambient:
        try:
            if not rsi_events.is_excluded(meta):
                voiced_s = float(meta.get("speech_s") or meta.get("duration") or 0.0)
                min_s = float(ambient.cfg.get("min_speech_s") or 20.0)
                rsi_ambient.record_discard_outcome(
                    mid, voiced_s, min_s, "user_deleted_short", device=str(ambient.cfg.get("device") or "")
                )
        except Exception:  # noqa: BLE001
            log.debug("rsi_ambient record user_deleted_short failed %s", mid, exc_info=True)
    invalidate_derived_caches(mid)
    return {"ok": True}


@app.post("/api/meetings/{mid}/trash")
def trash_meeting_api(mid: str):
    meta = _meta_or_404(mid)
    if is_live_active(mid):
        raise HTTPException(409, "正在录音，请先结束录音")
    ambient.discard(mid)
    try:
        trashed = store.trash_meeting(mid)
    except KeyError:
        raise HTTPException(404, "会议不存在") from None
    try:
        voiceprints.revoke_meeting(mid)
    except Exception:  # noqa: BLE001
        log.debug("voiceprints revoke on trash failed %s", mid, exc_info=True)
    invalidate_derived_caches(mid)
    return {"ok": True, "id": mid, "title": trashed.get("title") or meta.get("title") or ""}


@app.get("/api/trash")
def list_trash_api():
    return {"items": store.list_trash()}


@app.post("/api/trash/{mid}/restore")
def restore_trash_api(mid: str):
    try:
        meta = store.restore_trash(mid)
    except KeyError:
        raise HTTPException(404, "回收站里没有这条记录") from None
    except FileExistsError:
        raise HTTPException(409, "会议列表里已经存在这条记录") from None
    except ValueError as e:
        raise HTTPException(400, "记录标识无效") from e
    invalidate_derived_caches(mid)
    return {"ok": True, "meta": meta}


@app.delete("/api/trash/{mid}")
def purge_trash_api(mid: str):
    try:
        ok = store.purge_trash(mid)
    except ValueError as e:
        raise HTTPException(400, "记录标识无效") from e
    if not ok:
        raise HTTPException(404, "回收站里没有这条记录")
    return {"ok": True}


@app.post("/api/meetings/{mid}/transcribe")
def retranscribe(mid: str, body: dict = Body(default={})):
    meta = _meta_or_404(mid)
    if meta["status"] in ms.BUSY or is_live_active(mid) or _ambient_busy(mid):
        raise HTTPException(409, "正在处理中")
    d = store.mdir(mid)
    if not any((d / n).exists() for n in ("audio.wav", "audio.pcm", "audio.mp3")):
        raise HTTPException(400, "没有录音")
    fields = {}
    if "num_spk" in body:
        raw_spk = body["num_spk"]
        if isinstance(raw_spk, bool):
            raise HTTPException(400, "参会人数应为 0 或正整数")
        try:
            n = int(raw_spk or 0)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, "参会人数应为 0 或正整数") from e
        if n < 0:
            raise HTTPException(400, "参会人数应为 0 或正整数")
        fields["num_spk"] = n
    if "hotword" in body:
        fields["hotword"] = str(body["hotword"] or "")
    if fields:
        store.update(mid, **fields)
    queue_transcribe(mid)
    return store.get(mid)


def _skips(mid: str, meta: dict) -> list[dict]:
    """全天记录里没写进录音的长静音：新录音记在 skips.json；老录音从分段映射推出来。"""
    if meta.get("source") != "ambient":
        return []
    sk = store.load(mid, "skips.json")
    if sk is not None:
        return sk
    return skips_from_segmap(store.load(mid, "segmap.json"))


@app.get("/api/meetings/{mid}/peaks")
def audio_peaks(mid: str):
    meta = _meta_or_404(mid)
    try:
        p = waveform.peaks(store.mdir(mid), float(meta.get("duration") or 0))
    except RuntimeError as e:
        raise HTTPException(500, _friendly_error(e, "生成波形预览失败")) from e
    if p is None:
        raise HTTPException(404, "没有录音")
    return p


_audio_locks_guard = threading.Lock()
_audio_locks: dict[str, threading.Lock] = {}


def _audio_lock(mid: str) -> threading.Lock:
    with _audio_locks_guard:
        lk = _audio_locks.get(mid)
        if lk is None:
            if len(_audio_locks) > 512:
                for k in [x for x, v in _audio_locks.items() if not v.locked()]:
                    _audio_locks.pop(k, None)
            lk = _audio_locks[mid] = threading.Lock()
        return lk


@app.get("/api/meetings/{mid}/audio")
def audio(mid: str):
    meta = _meta_or_404(mid)
    d = store.mdir(mid)
    if not (d / "audio.mp3").exists() and not (d / "audio.wav").exists() and (d / "audio.pcm").exists() \
            and not is_live_active(mid) and not _ambient_busy(mid):
        with _audio_lock(mid):
            if not (d / "audio.mp3").exists() and not (d / "audio.wav").exists() and (d / "audio.pcm").exists() \
                    and not is_live_active(mid) and not _ambient_busy(mid):
                tmp_wav = d / f".audio.{os.getpid()}.{threading.get_ident()}.tmp.wav"
                try:
                    pcm_to_wav(d / "audio.pcm", tmp_wav, meta.get("audio_channels") or 1)
                    os.replace(tmp_wav, d / "audio.wav")
                except BaseException:
                    tmp_wav.unlink(missing_ok=True)
                    raise
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
CHUNK_BYTES = 3200  # 单声道 100ms。双声道是它的两倍，见 dual_audio.chunk_bytes
GAP_REASONS = {"hidden", "interrupted", "muted", "overflow", "stall"}


def _saved_channels(meta: dict | None) -> int:
    if not meta:
        return 0
    saved = int(meta.get("audio_channels") or (meta.get("live_rec") or {}).get("channels") or 0)
    return saved if saved in (1, 2) else 0


def _audio_channels(meta: dict | None, requested: int = 1, pcm_size: int = 0, resumed: bool = False) -> int:
    """已经写过的 pcm 以文件里记下的路数为准。新文件用这次请求的路数。"""
    saved = _saved_channels(meta)
    if saved and (resumed or pcm_size > 0):
        return saved
    return dual_audio.channels_of(requested)


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
    def phase(self) -> str:
        """recording（有连接在送音频）→ reconnecting（断线，等 LIVE_GRACE_S 内重连）→ ended（已收尾）。"""
        if self.done:
            return "ended"
        return "recording" if self.ws is not None else "reconnecting"

    @property
    def received(self) -> int:
        size = self.sess.file_bytes if self.sess else _pcm_size(self.mid)
        return max(0, size - self.start_bytes)


LIVE: dict[str, LiveRec] = {}


def _pcm_size(mid: str) -> int:
    p = store.mdir(mid) / "audio.pcm"
    return p.stat().st_size if p.exists() else 0


def _align_pcm(mid: str, start: int, channels: int = 1) -> None:
    """服务重启后接回录音：pcm 末尾可能只写了半块，截到整块，网页会从这里补发。"""
    p = store.mdir(mid) / "audio.pcm"
    if not p.exists():
        return
    size = p.stat().st_size
    keep = dual_audio.align_bytes(size, start, channels)
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
    finals = []
    for e in events:
        if e["type"] != "final":
            continue
        item = {k: e[k] for k in ("start", "end", "text")}
        if e.get("ch") in (0, 1):
            item["ch"] = e["ch"]
        finals.append(item)
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


async def _live_finalize(ctx: LiveRec, end: str, queue: bool = True, *, release_hold: bool = True) -> list[dict]:
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
        if release_hold:
            ambient.release(mid)
    store.update(mid, live_rec=None, live_state=None)
    log.info("live %s rec %s ended (%s): %d bytes, %d reconnects, %d gaps", mid, ctx.rec, end, ctx.h["received"],
             ctx.h["reconnects"], len(ctx.h["gaps"]))
    if queue:
        size = _pcm_size(mid)
        channels = _audio_channels(store.get(mid), pcm_size=size, resumed=True)
        if size > 16000 * 2 * channels:  # 超过 1 秒才转写
            store.update(mid, duration=dual_audio.pcm_duration_s(size, channels))
            queue_transcribe(mid)
        else:
            ms.transition(mid, ms.READY if store.load(mid, "live.json") else ms.NEW, reason="live_too_short")
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


_live_locks: dict[str, asyncio.Lock] = {}


def _live_lock(mid: str) -> asyncio.Lock:
    lk = _live_locks.get(mid)
    if lk is None:
        if len(_live_locks) > 256:
            for k in [x for x, v in _live_locks.items() if not v.locked() and x not in LIVE]:
                _live_locks.pop(k, None)
        lk = _live_locks[mid] = asyncio.Lock()
    return lk


def _open_live_session(pcm_path: Path, mid: str, meta: dict, channels: int, resumed: bool, start_bytes: int):
    if resumed:
        _align_pcm(mid, start_bytes, channels)
    return engine.live_session(pcm_path, _meeting_hotwords(mid, meta), channels)


@app.websocket("/ws/live/{mid}")
async def ws_live(ws: WebSocket, mid: str, rec: str = "", ch: int = 1):
    await ws.accept()

    async def fail(msg: str, code: str = "") -> None:
        with contextlib.suppress(Exception):
            await ws.send_json({"type": "error", "msg": msg, "code": code})
            await ws.close()

    if not store.exists(mid):
        return await fail("会议不存在", "gone")
    ctx = LIVE.get(mid)
    if ctx and ctx.rec != rec and ctx.ws is not None:
        return await fail("这个会议已在另一个页面录音", "busy")
    try:
        while not engine.ready:
            if engine.error:
                return await fail("语音模型加载失败: " + engine.error)
            await ws.send_json({"type": "status", "msg": "语音模型加载中…"})
            await asyncio.sleep(1)
    except (WebSocketDisconnect, RuntimeError):
        return

    old: WebSocket | None = None
    async with _live_lock(mid):
        meta = store.get(mid)
        if meta is None:
            return await fail("会议不存在", "gone")
        d = store.mdir(mid)
        if meta.get("source") in ("upload", "ambient"):
            return await fail("上传的录音和自动记录不能续录")
        ended = next((h for h in meta.get("rec_health") or [] if rec and h.get("rec") == rec and h.get("ended")), None)
        if ended:  # 这次录音已经收尾了（“结束”的回执丢了，或者断开太久被收尾）：告诉网页落盘到哪里，它自己算丢了多少
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "stopped", "already": True, "end": ended.get("end"),
                                    "file_bytes": int(ended.get("start_bytes") or 0) + int(ended.get("received") or 0)})
                await ws.close()
            return
        ctx = LIVE.get(mid)  # 等模型或等锁的时候可能变了
        inherited_hold = False
        if ctx and ctx.rec != rec:
            if ctx.ws is not None:
                return await fail("这个会议已在另一个页面录音", "busy")
            prev_owned = (not ctx.done) and (LIVE.get(mid) is ctx)
            await _live_finalize(ctx, "takeover", queue=False, release_hold=False)
            inherited_hold = prev_owned
            meta = store.get(mid)
            if meta is None:
                if inherited_hold:
                    ambient.release(mid)
                return await fail("会议不存在", "gone")
            ctx = LIVE.get(mid)
            if ctx is not None:
                if inherited_hold:
                    ambient.release(mid)
                return await fail("这个会议已在另一个页面录音", "busy")
        if ctx is None and (meta["status"] in ms.BUSY or _is_transcribe_inflight(mid)):
            if inherited_hold:
                ambient.release(mid)
            return await fail("正在转写这个会议，转写完再续录", "busy")
        resumed = ctx is not None
        prev_status = meta.get("status") or ms.NEW
        prev_live_rec = meta.get("live_rec")
        prev_live_state = meta.get("live_state")
        held = inherited_hold
        registered = False
        transitioned = False
        if not resumed:
            rec = rec or secrets.token_hex(8)
            start = _pcm_size(mid)
            requested = dual_audio.channels_of(ch)
            saved = _saved_channels(meta)
            if start > 0 and saved and saved != requested:
                if held:
                    ambient.release(mid)
                return await fail("这次会议已经按" + ("「麦克风 + 电脑声音」" if saved == 2 else "麦克风") + "录过，续录请选同样的音频来源")
            start -= start % (2 * (saved or requested))
            ctx = LiveRec(mid, rec, start, {"rec": rec, "device": _device(ws), "started": datetime.now().isoformat(timespec="seconds"),
                                            "ended": None, "end": "", "start_bytes": start, "reconnects": 0, "gaps": [],
                                            "produced": 0, "dropped": 0, "received": 0})
        try:
            if not resumed:
                LIVE[mid] = ctx
                registered = True
                if not held:
                    await asyncio.to_thread(ambient.hold, mid)
                    held = True
            else:
                if ctx.timer:
                    ctx.timer.cancel()
                    ctx.timer = None
                ctx.h["reconnects"] += 1
                ctx.h["device"] = ctx.h.get("device") or _device(ws)
            old = ctx.ws
            async with ctx.feed_lock:  # 换成新连接：旧连接（半开、还没察觉断了的）之后收到的数据都丢掉，网页会按 file_bytes 补发
                if ctx.sess is None:  # 新录音，或者服务重启后第一次连回来
                    channels = _audio_channels(meta, ch, _pcm_size(mid), resumed)
                    ctx.sess = await asyncio.to_thread(
                        _open_live_session, d / "audio.pcm", mid, meta, channels, resumed, ctx.start_bytes)
                else:
                    # 丢弃断线前未凑满一帧的残余字节：重连后客户端会从已落盘的 file_bytes 重新对齐补发
                    ctx.sess._byte_rem = b""
                ctx.ws, ctx.detached_at = ws, None
                file_bytes = ctx.sess.file_bytes
            if old is not None:
                asyncio.create_task(_close_quietly(old))
                old = None
            channels = ctx.sess.channels if ctx.sess is not None else _audio_channels(meta, ch)
            ms.transition(mid, ms.RECORDING, reason="live_resume" if resumed else "live_start", source="mic",
                          audio_channels=channels,
                          live_rec={"rec": ctx.rec, "start_bytes": ctx.start_bytes, "channels": channels}, live_state=None)
            transitioned = True
            _save_health(ctx)
            await ws.send_json({"type": "ready", "rec": ctx.rec,
                                "offset_ms": dual_audio.offset_ms(ctx.start_bytes, channels),
                                "start_bytes": ctx.start_bytes,
                                "file_bytes": file_bytes, "resumed": resumed, "grace_s": LIVE_GRACE_S,
                                "channels": channels})
        except BaseException as exc:
            if not resumed:
                if ctx.sess is not None:
                    with contextlib.suppress(Exception):
                        ctx.sess.close()
                    ctx.sess = None
                ctx.ws = None
                ctx.done = True
                if registered and LIVE.get(mid) is ctx:
                    LIVE.pop(mid, None)
                if held:
                    ambient.release(mid)
                if transitioned and store.exists(mid):
                    with contextlib.suppress(Exception):
                        ms.transition(mid, prev_status, reason="live_setup_failed",
                                      live_rec=prev_live_rec, live_state=prev_live_state)
            else:
                if old is not None:
                    asyncio.create_task(_close_quietly(old))
                if not ctx.done and (ctx.ws is ws or ctx.ws is None):
                    if ctx.ws is ws:
                        ctx.ws = None
                    if ctx.ws is None and ctx.timer is None:
                        _live_detach(ctx)
            if isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                return
            raise
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
                try:
                    j = json.loads(msg["text"])
                except json.JSONDecodeError:
                    continue
                if not isinstance(j, dict):
                    continue
                t = j.get("type")
                if t in ("stat", "stop"):
                    with contextlib.suppress(TypeError, ValueError):
                        ctx.h["produced"] = int(j.get("produced") or 0)
                        ctx.h["dropped"] = int(j.get("dropped") or 0)
                if t == "stop":
                    await emit(await _live_finalize(ctx, "stop"), persist=False)
                    stopped = True
                    break
                if t == "gap" and len(ctx.h["gaps"]) < 500:
                    with contextlib.suppress(TypeError, ValueError):
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


def _history_texts(mid: str, limit: int = 20) -> list[tuple[str, float]]:
    """最近若干场会议的带权重文本，用来找反复出现的专名。不算这场自己。
    人工确认的来源（笔记 > 手写标题 > 手改段落）权重高于未校对原始转写，避免 ASR 错词自我强化。"""
    out: list[tuple[str, float]] = []
    n_meetings = 0
    for m in store.list_all():
        oid = m.get("id")
        if oid == mid:
            continue
        added = False
        notes_t = _notes(oid).strip()
        if notes_t:
            out.append((notes_t, 3.0))
            added = True
        if m.get("title") and not m.get("title_auto"):
            out.append((str(m["title"]), 2.5))
            added = True
        tr = store.load(oid, "transcript.json") or {}
        paras = (tr.get("paragraphs") or [])[:300]
        if paras:
            edited_t = "\n".join(p.get("text") or "" for p in paras if p.get("edited"))
            raw_t = "\n".join(p.get("text") or "" for p in paras if not p.get("edited"))
            if edited_t.strip():
                out.append((edited_t, 2.0))
                added = True
            if raw_t.strip():
                out.append((raw_t, 1.0))
                added = True
        if added:
            n_meetings += 1
            if n_meetings >= limit:
                break
    return out


def _meeting_hotwords(mid: str, meta: dict) -> str:
    import context_hotwords
    return context_hotwords.for_meeting(meta, _notes(mid), _history_texts(mid), vocab.hotwords(""))


def _paras(mid: str) -> list[dict]:
    tr = store.load(mid, "transcript.json")
    if tr is not None:
        return vocab.apply_paras(tr.get("paragraphs") or [])
    # 会后转写未完成时，用实时转写稿
    return [{"spk": 0, "start": x["start"], "end": x["end"], "text": x["text"]}
            for x in vocab.apply_paras(store.load(mid, "live.json", []))]


def _prov_named(name: str | None) -> dict:
    """按纪要里记下的模型名找回接口；找不到就用当前默认。"""
    if name:
        for p in store.get_settings().get("providers") or []:
            if p.get("name") == name:
                return store.provider(p["id"])
    return store.provider(None)


def _save_minutes(mid: str, rec: dict) -> None:
    with store.locked():
        store.save(mid, "minutes.json", rec)
        m = re.match(r"#\s+(.+)", rec.get("markdown") or "")
        cur = store.get(mid) or {}
        if m and cur.get("title_source") != "manual" and (cur.get("title_auto") or cur.get("title_source") == "local_brief"):
            store.update(mid, title=m.group(1).strip()[:40], title_auto=False, title_source="minutes")


async def _chat_progress(prov: dict, messages: list[dict], on_status=None, **kw) -> str:
    """走流式接口；模型还在思考时把秒数推给页面，避免纪要一直停在「准备中」。"""
    parts: list[str] = []
    async for kind, v in chat_events(prov, messages, **kw):
        if kind == "think":
            if on_status:
                await on_status(f"{prov['name']} 正在思考，已 {v} 秒")
        else:
            parts.append(v)
    return "".join(parts)


async def compose_minutes(mid: str, template: str, prov: dict, on_status=None) -> dict:
    """按当前转写生成纪要记录，不负责保存。"""
    meta = store.get(mid)
    if not meta:
        raise KeyError(mid)
    tr = store.load(mid, "transcript.json")
    if tr is not None:
        paras = vocab.apply_paras(tr.get("paragraphs") or [])
        from_live = False
    else:
        paras = [{"spk": 0, "start": x["start"], "end": x["end"], "text": x["text"]}
                 for x in vocab.apply_paras(store.load(mid, "live.json", []))]
        from_live = True
    if not paras:
        raise ValueError("还没有转写内容")
    notes = _notes(mid)
    lines = prompts.transcript_lines(meta, paras)
    budget = max(4000, int(prov.get("max_input_chars") or 60000))
    t0 = time.time()

    async def status(msg: str) -> None:
        if on_status:
            await on_status(msg)

    total = sum(len(x) + 1 for x in lines)
    if total <= budget:
        body_text, partial = "\n".join(lines), False
    else:
        chunks = prompts.chunk_lines(lines, max(1000, int(budget * 0.8)))
        sem = asyncio.Semaphore(1 if llm.is_local_url(prov.get("base_url") or "") else 4)

        async def _map_part(i: int, ch: list[str]) -> str:
            async with sem:
                await status(f"会议较长，正在分段提炼 {i}/{len(chunks)}…")
                return f"【第 {i} 部分】\n" + await _chat_progress(prov, [
                    {"role": "system", "content": "你是会议纪要助手，擅长提炼要点。"},
                    {"role": "user", "content": prompts.MAP_PROMPT.format(i=i, n=len(chunks), text="\n".join(ch))},
                ], on_status=status, max_tokens=3000)

        parts = list(await asyncio.gather(*(_map_part(i, ch) for i, ch in enumerate(chunks, 1))))
        body_text, partial = "\n\n".join(parts), True
        if len(body_text) > budget:
            per_part = max(500, budget // len(parts))
            body_text = "\n\n".join(p[:per_part] for p in parts)[:budget]
    await status(f"{prov['name']} 正在整理纪要，写完会核对期限和出处…")
    marks_cap = min(marks_mod._TOTAL_CHARS, max(1500, budget // 5))
    marks_text = marks_mod.prompt_block(meta, marks_mod.load(mid), paras, prompts.spk_name, max_total_chars=marks_cap)
    raw = await _chat_progress(prov, prompts.minutes_json_messages(meta, notes, template, body_text, partial, marks_text=marks_text),
                               on_status=status, temperature=0)
    await status("正在用转写核对截止期限、负责人和时间戳…")
    doc, checks = minutes_check.build(raw, paras, speakers=meta.get("speakers"), notes=notes)
    out = minutes_check.render(doc, template)
    return {"markdown": out, "template": template, "provider": prov["name"], "model": prov["model"],
            "created": datetime.now().isoformat(timespec="seconds"), "cost": round(time.time() - t0, 1),
            "src_hash": _hash("\n".join(lines)), "notes_hash": _hash(notes.strip()),
            "from_live": from_live,
            "checks": checks, "highlights": doc.get("highlights") or []}


def refresh_minutes_after_transcript(mid: str) -> bool:
    """精准转写写完之后：实时稿纪要或已经对不上的纪要，用带说话人的精转稿重写。手改过的不动。"""
    mn = store.load(mid, "minutes.json")
    meta = store.get(mid)
    if not mn or not meta:
        return False
    lines = prompts.transcript_lines(meta, _paras(mid))
    digest = _hash("\n".join(lines))

    def _due(record: dict) -> bool:
        changed = bool(record.get("src_hash")) and record["src_hash"] != digest
        return minutes_check.should_auto_refresh(
            record, from_live=bool(record.get("from_live")), transcript_changed=changed)

    if not _due(mn):
        return False
    prov = _prov_named(mn.get("provider"))
    template = mn.get("template") or meta.get("template") or "general"
    rec = asyncio.run(compose_minutes(mid, template, prov))
    # 生成期间用户若手改或自己重写了，以现在这份为准，不覆盖
    if not store.exists(mid) or not _due(store.load(mid, "minutes.json") or {}):
        log.info("minutes refresh skipped, edited or replaced during generation %s", mid)
        return False
    _save_minutes(mid, rec)
    log.info("minutes refreshed after transcript %s", mid)
    return True


_minutes_tasks: dict[str, asyncio.Task] = {}


@app.post("/api/meetings/{mid}/minutes")
async def gen_minutes(mid: str, body: dict = Body(default={})):
    meta = _meta_or_404(mid)
    template = body.get("template") or meta.get("template") or "general"
    prov = _prov(body.get("provider"))
    if not _paras(mid):
        raise HTTPException(400, "还没有转写内容")

    async def gen():
        q: asyncio.Queue = asyncio.Queue()

        async def on_status(msg: str) -> None:
            await q.put(msg)

        prev = _minutes_tasks.get(mid)
        if prev is not None and not prev.done():
            prev.cancel()
        task = asyncio.create_task(compose_minutes(mid, template, prov, on_status))
        _minutes_tasks[mid] = task
        last_emit = time.monotonic()
        try:
            while True:
                if task.done() and q.empty():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), 0.3)
                except asyncio.TimeoutError:
                    if not task.done() and time.monotonic() - last_emit >= 10.0:
                        last_emit = time.monotonic()
                        yield _ndjson({"type": "status", "msg": f"{prov['name']} 正在整理纪要…"})
                    continue
                last_emit = time.monotonic()
                yield _ndjson({"type": "status", "msg": msg})
            rec = await task
            if store.exists(mid):
                _save_minutes(mid, rec)
            yield _ndjson({"type": "delta", "text": rec["markdown"]})
            yield _ndjson({"type": "done", "minutes": rec})
        except asyncio.CancelledError:
            if not task.done():
                task.cancel()
            raise
        except LLMError as e:
            yield _ndjson({"type": "error", "msg": str(e)})
        except ValueError as e:
            yield _ndjson({"type": "error", "msg": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("minutes")
            yield _ndjson({"type": "error", "msg": _friendly_error(e, "整理纪要时出错，请稍后再试")})
        finally:
            if _minutes_tasks.get(mid) is task:
                _minutes_tasks.pop(mid, None)
            if not task.done():
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task

    return StreamingResponse(gen(), media_type="application/x-ndjson")


def _bigrams(s: str) -> set:
    s = re.sub(r"\W", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1)}


@app.post("/api/meetings/{mid}/speaker-names")
async def guess_speaker_names(mid: str, body: dict = Body(default={})):
    """推测各说话人是谁：模型从转写里找自我介绍、点名后回应这类直接线索，摘句逐字核对过才返回。只给建议，改不改名由用户决定。"""
    meta = _meta_or_404(mid)
    prov = _prov(body.get("provider"))
    paras = await asyncio.to_thread(_paras, mid)
    if not paras or len({p["spk"] for p in paras}) < 2:
        raise HTTPException(400, "还没有区分说话人的转写")
    plain = {**meta, "speakers": {}}  # 一律用“说话人N”，模型给的编号才对得上
    lines = prompts.transcript_lines(plain, paras)
    hw = vocab.hotwords(meta.get("hotword", ""))
    head = f"热词（专有名词正确写法）：{hw}\n" if hw else ""
    budget = max(4000, int(prov.get("max_input_chars") or 60000))
    t0, raw = time.time(), []
    chunks = prompts.chunk_lines(lines, max(1000, int(budget * 0.8)))
    sem = asyncio.Semaphore(1 if llm.is_local_url(prov.get("base_url") or "") else 4)

    async def _one(ch: list[str]) -> list:
        async with sem:
            out = await chat(prov, [{"role": "user", "content": prompts.SPK_NAME_PROMPT.format(head=head, text="\n".join(ch))}],
                             temperature=0.1, max_tokens=4000)
            try:
                parsed = minutes_check.parse_json(out)
                cands = parsed.get("candidates")
                return cands if isinstance(cands, list) else []
            except ValueError:
                log.warning("speaker-names: 模型没按 JSON 输出：%s", out[:200])
                return []

    try:
        for batch in await asyncio.gather(*(_one(ch) for ch in chunks)):
            raw += batch
    except LLMError as e:
        raise HTTPException(502, str(e)) from e
    return {"candidates": prompts.check_name_candidates(raw, paras), "raw_count": len(raw),
            "provider": prov["name"], "cost": round(time.time() - t0, 1)}


def _append_qa(mid: str, q: str, answer: str) -> None:
    if not store.exists(mid):
        return
    with _qa_lock:
        if not store.exists(mid):
            return
        cur = store.load(mid, "qa.json", [])
        if not isinstance(cur, list):
            cur = []
        cur.append({"q": q, "a": answer, "t": datetime.now().isoformat(timespec="seconds")})
        store.save(mid, "qa.json", cur)


@app.post("/api/meetings/{mid}/ask")
async def ask(mid: str, body: dict = Body(...)):
    meta = _meta_or_404(mid)
    q = (body.get("question") or "").strip()
    if not q:
        raise HTTPException(400, "问题为空")
    prov = _prov(body.get("provider"))
    paras, notes_text = await asyncio.to_thread(lambda: (_paras(mid), _notes(mid)))
    lines = prompts.transcript_lines(meta, paras)
    mn = store.load(mid, "minutes.json") or {}
    # 纪要生成后转写改过的话，旧纪要里的名字和内容可能是错的，不拿来当参考
    minutes = "" if "transcript" in _minutes_stale(mid, meta, mn, paras=paras, notes=notes_text) else mn.get("markdown", "")
    maxc = max(4000, int(prov.get("max_input_chars") or 60000))
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
    ctx = prompts.context_header(meta, notes_text)
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
            await asyncio.to_thread(_append_qa, mid, q, out.strip())
            yield _ndjson({"type": "done"})
        except LLMError as e:
            yield _ndjson({"type": "error", "msg": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("ask")
            yield _ndjson({"type": "error", "msg": _friendly_error(e, "回答生成失败，请稍后再试")})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


_qa_lock = threading.Lock()


@app.delete("/api/meetings/{mid}/qa")
def clear_qa(mid: str):
    _meta_or_404(mid)
    with _qa_lock:
        prev = store.load(mid, "qa.json", [])
        store.save(mid, "qa.json", [])
    return {"ok": True, "cleared": prev if isinstance(prev, list) else []}


@app.post("/api/meetings/{mid}/qa/restore")
def restore_qa(mid: str, body: dict = Body(...)):
    _meta_or_404(mid)
    raw = body.get("items")
    if not isinstance(raw, list):
        raise HTTPException(400, "问答恢复内容格式不正确")
    merged: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for x in raw:
        if not isinstance(x, dict) or not str(x.get("q") or "").strip():
            continue
        k = (str(x.get("q") or ""), str(x.get("a") or ""), str(x.get("t") or ""))
        if k not in seen:
            seen.add(k)
            merged.append({"q": k[0], "a": k[1], "t": k[2]})
    with _qa_lock:
        current = store.load(mid, "qa.json") or []
        if isinstance(current, list):
            for x in current:
                if not isinstance(x, dict) or not str(x.get("q") or "").strip():
                    continue
                k = (str(x.get("q") or ""), str(x.get("a") or ""), str(x.get("t") or ""))
                if k not in seen:
                    seen.add(k)
                    merged.append(x)
        store.save(mid, "qa.json", merged)
    return {"ok": True, "qa": merged}


# ---------------- 导出 ----------------
def _srt_ts(ms: int) -> str:
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def _highlights_md(mid: str, mn: dict | None, paras: list[dict]) -> str:
    """纪要后面附的「要点」和「打点」两节（导出用）。都没有就返回空串。"""
    out = []
    marks = marks_mod.load(mid)
    hl = [h for h in ((mn or {}).get("highlights") or []) if isinstance(h, dict) and h.get("text")]
    if hl:
        out.append("## 要点\n")
        for h in hl:
            if h.get("start_ms") is None:
                out.append(f"- {h['text']}")
                continue
            span = f"[{fmt_ts(h['start_ms'])}]" + (f"–[{fmt_ts(h['end_ms'])}]" if h.get("end_ms") and h["end_ms"] // 1000 != h["start_ms"] // 1000 else "")
            star = "★ " if marks_mod.near(marks, h["start_ms"], h.get("end_ms")) else ""
            out.append(f"- {star}{h['text']} {span}")
        out.append("")
    if marks:
        out.append("## 打点\n")
        for m in marks:
            sn = marks_mod.snippet(paras, m["t_ms"])
            out.append(f"- [{fmt_ts(m['t_ms'])}]" + (f" {m['label']}" if m.get("label") else "") + (f"：{sn}" if sn else ""))
        out.append("")
    return "\n".join(out)


def _minutes_md(mid: str, meta: dict, paras: list[dict], with_transcript: bool) -> str:
    mrec = store.load(mid, "minutes.json") or {}
    notes = _notes(mid)
    mn = mrec.get("markdown", "")
    if mn and "transcript" in _minutes_stale(mid, meta, mrec, paras=paras, notes=notes):
        mn += "\n\n> 注意：这份纪要生成后，转写内容（文字或说话人姓名）有改动，纪要可能没有反映最新内容。"
    parts = [mn or f"# {meta['title']}",
             f"\n> 时间：{meta['created'].replace('T', ' ')}　时长：{fmt_ts(meta.get('duration', 0) * 1000)}"]
    extra = _highlights_md(mid, mrec, paras)
    if extra:
        parts.append("\n" + extra)
    if notes.strip():
        parts.append("\n## 我的笔记\n\n" + notes.strip())
    if with_transcript:
        parts.append("\n## 完整转写\n")
        parts += [f"**{prompts.spk_name(meta, p['spk'])}** [{fmt_ts(p['start'])}]：{p['text']}\n" for p in paras]
    return "\n".join(parts)


def _export_zip(mid: str, meta: dict, paras: list[dict], safe_title: str):
    """单场会议打包：音频原文件（有才放）、转写 TXT、纪要 Markdown（含要点和打点）。"""
    from urllib.parse import quote
    d = store.mdir(mid)
    txt = "\n\n".join(f"[{fmt_ts(p['start'])}] {prompts.spk_name(meta, p['spk'])}：{p['text']}" for p in paras)
    tmp = tempfile.NamedTemporaryFile(prefix="mn-export-", suffix=".zip", delete=False)
    tmp.close()
    try:
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("转写.txt", txt + "\n")
            z.writestr("纪要.md", _minutes_md(mid, meta, paras, with_transcript=False))
            for name in ("audio.mp3", "audio.wav"):  # 优先 mp3；都没有就不放音频
                if (d / name).exists():
                    z.write(d / name, "音频" + name[5:], compress_type=zipfile.ZIP_STORED)
                    break
    except Exception:
        os.unlink(tmp.name)
        raise
    fname = safe_title + ".zip"
    return FileResponse(tmp.name, media_type="application/zip", background=BackgroundTask(os.unlink, tmp.name),
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(fname)}"})


@app.get("/api/meetings/{mid}/export")
def export(mid: str, fmt: str = "md"):
    meta = _meta_or_404(mid)
    paras = _paras(mid)
    name = lambda p: prompts.spk_name(meta, p["spk"])  # noqa: E731
    safe_title = re.sub(r'[\\/:*?"<>|]', "_", meta["title"])
    if fmt == "zip":
        return _export_zip(mid, meta, paras, safe_title)
    if fmt == "srt":
        body = "\n".join(f"{i}\n{_srt_ts(p['start'])} --> {_srt_ts(p['end'])}\n{name(p)}：{p['text']}\n"
                         for i, p in enumerate(paras, 1))
    elif fmt == "txt":
        body = "\n\n".join(f"[{fmt_ts(p['start'])}] {name(p)}：{p['text']}" for p in paras)
    else:
        body = _minutes_md(mid, meta, paras, with_transcript=True)
        fmt = "md"
    fname = safe_title + "." + fmt
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
    with store.locked():
        cur = store.get_settings()
        old = {p["id"]: p for p in cur["providers"]}
        provs = []
        used = set()
        raw_provs = body.get("providers", [])
        if not isinstance(raw_provs, list):
            raise HTTPException(400, "模型接口配置格式不正确")
        for p in raw_provs:
            if not isinstance(p, dict):
                raise HTTPException(400, "模型接口配置格式不正确")
            pid = p.get("id") or re.sub(r"\W", "", p.get("name", "custom")).lower() or f"p{int(time.time())}"
            while pid in used:
                pid += "_2"
            used.add(pid)
            key = p.get("api_key")
            if key is None or key == "" and p.get("keep_key", True):
                key = old.get(pid, {}).get("api_key", "")
            extra = _parse_extra_body(p.get("extra_body"), f"「{p.get('name')}」的额外参数")
            try:
                max_chars = max(4000, int(p.get("max_input_chars") or 60000))
            except (TypeError, ValueError) as e:
                raise HTTPException(400, f"「{p.get('name')}」的最大输入字数应为整数") from e
            provs.append({"id": pid, "name": p.get("name") or pid, "base_url": str(p.get("base_url") or "").strip(),
                          "api_key": str(key or "").strip(), "env_key": str(p.get("env_key", old.get(pid, {}).get("env_key", "")) or ""),
                          "model": str(p.get("model") or "").strip(), "max_input_chars": max_chars,
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
    AUTO_DAILY.pop(datetime.now().strftime("%Y-%m-%d"), None)
    return get_settings()


@app.post("/api/settings/restore-providers")
def restore_providers():
    n = store.restore_default_providers()
    return {**get_settings(), "restored": n}


def _parse_extra_body(raw, label: str = "额外参数") -> dict:
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"{label}格式不正确") from e
    if not isinstance(raw, dict):
        raise HTTPException(400, f"{label}格式不正确")
    return raw


@app.post("/api/settings/test")
async def test_provider(body: dict = Body(...)):
    if (
        body.get("base_url")
        or body.get("model")
        or body.get("api_key")
        or "extra_body" in body
        or body.get("keep_key") is False
    ):
        saved = _active_prov_optional(body.get("id")) if body.get("id") else None
        raw_key = body.get("api_key")
        if raw_key is not None and str(raw_key).strip():
            key = str(raw_key).strip()
        elif body.get("keep_key") is False:
            key = ""
        else:
            key = saved.get("api_key", "") if saved else ""
        if "extra_body" in body:
            extra = _parse_extra_body(body.get("extra_body"), "当前配置的额外参数")
        else:
            extra = saved.get("extra_body", {}) if saved else {}
        prov = {
            "id": str(body.get("id") or "draft"),
            "name": str(body.get("name") or (saved.get("name") if saved else "") or "当前接口"),
            "base_url": str(body.get("base_url") or (saved.get("base_url") if saved else "")).strip(),
            "api_key": key,
            "model": str(body.get("model") or (saved.get("model") if saved else "")).strip(),
            "max_input_chars": int(
                body.get("max_input_chars") or (saved.get("max_input_chars") if saved else None) or 60000
            ),
            "extra_body": extra,
        }
        if not prov["base_url"] or not prov["model"]:
            return {"ok": False, "msg": "请先填写接口地址和模型名称"}
    else:
        prov = _prov(body.get("id"))
    t = time.time()
    try:
        out = await chat(prov, [{"role": "user", "content": "只回复两个字：你好"}], max_tokens=256)
        return {"ok": True, "reply": out.strip()[:50], "latency": round(time.time() - t, 2)}
    except LLMError as e:
        return {"ok": False, "msg": str(e)}


# ---------------- 全天模式 ----------------
_today_lock = threading.Lock()
_today: dict = {"key": None, "t": 0.0, "val": None}
_amb_waiters_lock = threading.Lock()
_amb_waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()


def _notify_ambient_waiters() -> None:
    with _amb_waiters_lock:
        targets = list(_amb_waiters)
    for loop, ev in targets:
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(ev.set)


def _amb_today() -> dict:
    """今天的自动记录段数和发言时长。按当天前缀筛选并用 meta 缓存，加锁防多线程并发写。"""
    c = ambient.conv
    today = datetime.now().strftime("%Y-%m-%d")
    key = (today, c.mid if c else "")
    now = time.time()
    with _today_lock:
        if _today["key"] == key and now - _today["t"] <= 5 and _today["val"] is not None:
            return dict(_today["val"])
    day_ms = [m for m in store.list_by_date(today) if m.get("source") == "ambient"]
    val = {"date": today, "count": len(day_ms), "speech_s": round(sum(m.get("speech_s", 0) for m in day_ms))}
    with _today_lock:
        _today.update(key=key, t=time.time(), val=val)
        return dict(val)


@app.get("/api/discarded")
def discarded_list():
    """最近被自动丢弃、还在 7 天保留期内的短对话。"""
    return {"items": [{**it, "text": vocab.apply(it.get("text") or "")} for it in store.list_discarded()]}


@app.post("/api/discarded/{mid}/restore")
def discarded_restore(mid: str):
    try:
        store.restore_discarded(mid)
    except KeyError:
        raise HTTPException(404, "没有这段丢弃的对话") from None
    except FileExistsError:
        raise HTTPException(409, "会议列表里已经有这场") from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    d = store.mdir(mid)
    if any((d / n).exists() for n in ("audio.wav", "audio.pcm", "audio.mp3")):
        queue_transcribe(mid)  # 和正常结束的全天对话一样，去精准转写
    elif (store.get(mid) or {}).get("status") in ms.ACTIVE:
        # 没有录音可转写：不能一直挂在“记录中”（以前要等下次重启才会被纠正）
        ms.transition(mid, ms.READY if store.load(mid, "live.json") else ms.NEW, reason="restore_no_audio")
    return store.get(mid)


@app.get("/api/ambient")
def ambient_status():
    st = ambient.status()
    st["today"] = _amb_today()
    return st


@app.websocket("/ws/ambient")
async def ws_ambient(ws: WebSocket):
    """全天模式状态推送：开启采音时 0.15 秒检测变化；关闭/暂停/占用时退避到 2 秒并在状态操作时立即唤醒。"""
    await ws.accept()
    ambient.viewers += 1
    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    waiter = (loop, wake)
    with _amb_waiters_lock:
        _amb_waiters.add(waiter)
    recv = asyncio.ensure_future(ws.receive())
    last, sent_at = None, 0.0
    try:
        while True:
            wake.clear()
            st = await asyncio.to_thread(ambient_status)
            if st != last or time.time() - sent_at > 20:  # 没变化时 20 秒发一次心跳
                await ws.send_json(st)
                last, sent_at = st, time.time()
            interval = 0.15 if (ambient.enabled and ambient.state in ("listening", "speech", "starting")) else 2.0
            wake_task = asyncio.create_task(wake.wait())
            done, _ = await asyncio.wait({recv, wake_task}, timeout=interval, return_when=asyncio.FIRST_COMPLETED)
            if not wake_task.done():
                wake_task.cancel()
                with contextlib.suppress(BaseException):
                    await wake_task
            if recv in done:  # 网页关闭或服务退出；网页不会主动发消息
                if recv.result()["type"] == "websocket.disconnect":
                    break
                recv = asyncio.ensure_future(ws.receive())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        ambient.viewers -= 1
        with _amb_waiters_lock:
            _amb_waiters.discard(waiter)
        recv.cancel()
        with contextlib.suppress(BaseException):
            await recv


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
    _notify_ambient_waiters()
    return ambient_status()


def _parse_hhmm(raw: str) -> tuple[int, int] | None:
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", (raw or "").strip())
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if not (0 <= h <= 23 and 0 <= mi <= 59):
        return None
    return h, mi


@app.put("/api/ambient/config")
def ambient_config(body: dict = Body(...)):
    with store.locked():
        cfg = dict(ambient.cfg)
        old_summary_time = cfg.get("summary_time")
        for k, typ in (("device", str), ("hotword", str), ("summary_time", str), ("split_min", float),
                       ("min_speech_s", float), ("max_conv_min", float), ("audio_keep_days", int), ("keep_awake", bool), ("keep_silence", bool),
                       ("sensitivity", str)):
            if k in body:
                try:
                    cfg[k] = typ(body[k]) if body[k] is not None else cfg[k]
                except (TypeError, ValueError) as e:
                    raise HTTPException(400, f"参数 {k} 不合法") from e
        if cfg["summary_time"] and _parse_hhmm(cfg["summary_time"]) is None:
            raise HTTPException(400, "汇总时间格式应为 HH:MM（00:00–23:59）")
        if cfg["sensitivity"] not in SENS:
            raise HTTPException(400, "灵敏度应为 " + " / ".join(SENS))
        cfg["split_min"] = min(max(cfg["split_min"], 1), 60)
        cfg["max_conv_min"] = min(max(cfg["max_conv_min"], 10), 240)
        cfg["min_speech_s"] = min(max(cfg["min_speech_s"], 0), 600)
        cfg["enabled"] = ambient.cfg.get("enabled", False)
        save_ambient_cfg(cfg)
        ambient.reload_cfg()
    if cfg.get("summary_time") != old_summary_time:
        AUTO_DAILY.pop(datetime.now().strftime("%Y-%m-%d"), None)
    _notify_ambient_waiters()
    return ambient_status()


@app.get("/api/ambient/devices")
def ambient_devices():
    return {"devices": list_devices()}


@app.get("/api/ambient/storage")
def ambient_storage():
    """「不跳过静音」的空间代价：按最近两周的全天记录估算两种写法每天各占多少。"""
    return {**storage_estimate(store.list_all()), "keep_days": int(ambient.cfg.get("audio_keep_days") or 0)}


@app.get("/api/ambient/purge-preview")
def ambient_purge_preview(days: int):
    """把录音保留天数改成 days 后，会删掉多少段录音（保存设置前让用户确认）。"""
    return {"count": len(purge_candidates(days))}


# ---------------- 状态总览（只读，给开发者和代理排查用） ----------------
@app.get("/api/state")
def app_state():
    """所有状态机此刻的状态：会议生命周期、转写队列、实时录音、全天模式、语音模型、自动汇总、局域网。
    只读，不触发任何动作。各状态的含义和跳转见 docs/state-machines.md。"""
    metas = store.list_all()
    counts = {s: 0 for s in ms.STATES}
    for m in metas:
        counts[m.get("status") or ms.NEW] = counts.get(m.get("status") or ms.NEW, 0) + 1
    with _inflight_lock:
        inflight = sorted(_inflight)
    now = time.time()
    live = []
    for mid, ctx in list(LIVE.items()):
        item = {"id": mid, "rec": ctx.rec, "phase": ctx.phase, "device": ctx.h.get("device") or ""}
        if ctx.phase == "reconnecting" and ctx.detached_at:
            item["grace_left"] = max(0, round(LIVE_GRACE_S - (now - ctx.detached_at)))
        live.append(item)
    p = _llm["proc"]
    return {
        "now": round(now, 3),
        "meetings": {
            "counts": counts,
            "active": [{"id": m["id"], "status": m["status"], "source": m.get("source", ""), "title": m.get("title", "")}
                       for m in metas if m.get("status") in ms.ACTIVE or m.get("status") == ms.ERROR][:50],
            "recent_transitions": ms.history(30),
            "unexpected_transitions": ms.illegal_count(),
        },
        "transcribe_queue": {"inflight": inflight},
        "live": live,
        "ambient": ambient.state_info(),
        "engine": engine.state_info(),
        "auto_daily": {d: dict(v) for d, v in AUTO_DAILY.items()},
        "lan": {"running": lan.server.running, "port": lan.server.port, "error": lan.server.error},
        "local_llm": {"ours": bool(p and p.poll() is None)},
        "rsi": _rsi_summary_safe(),
        "schema": {"meeting": ms.schema(),
                   "ambient": {"states": list(AMBIENT_STATES),
                               "transitions": {k: sorted(v) for k, v in AMBIENT_TRANSITIONS.items()}},
                   "live": ["recording", "reconnecting", "ended"],
                   "engine": {"main": ["idle", "loading", "ready", "error"], "nano": ["unloaded", "loading", "ready", "failed"]}},
    }


# ---------------- 自学习（RSI，纯本地） ----------------
def _rsi_payload() -> dict:
    min_s = float(ambient.cfg.get("min_speech_s") or 20.0)
    return {
        "config": rsi_events.get_config(),
        "voiceprints": voiceprints.summary(),
        "vocab": rsi_vocab.summary(),
        "ambient": rsi_ambient.summary(min_s),
        "registry": rsi_events.get_registry(30),
    }


def _rsi_summary_safe() -> dict:
    try:
        return _rsi_payload()
    except Exception:  # noqa: BLE001
        log.debug("rsi summary failed", exc_info=True)
        return {"config": dict(rsi_events.DEFAULT_CONFIG), "error": "unavailable"}


_RSI_BODY = Body(...)


@app.get("/api/rsi")
def get_rsi():
    return _rsi_payload()


@app.put("/api/rsi/config")
def put_rsi_config(body: dict = _RSI_BODY):
    patch: dict = {}
    for k in ("paused", "auto_name"):
        if k in body:
            if not isinstance(body[k], bool):
                raise HTTPException(400, "自学习开关参数格式不正确")
            patch[k] = body[k]
    return rsi_events.save_config(patch)


@app.delete("/api/rsi/voiceprints/{name:path}")
def delete_rsi_voiceprint(name: str):
    if not voiceprints.delete_person(name):
        raise HTTPException(404, "未找到该声纹")
    return {"ok": True}


@app.post("/api/rsi/voiceprints/undo")
def undo_rsi_voiceprint(body: dict = _RSI_BODY):
    mid = str(body.get("mid") or "").strip()
    if not mid:
        raise HTTPException(400, "缺少会议标识")
    try:
        _meta_or_404(mid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    raw_spk = body.get("spk")
    if isinstance(raw_spk, bool) or raw_spk is None:
        raise HTTPException(400, "说话人编号不合法")
    try:
        spk = int(raw_spk)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "说话人编号不合法") from e
    if spk < 0:
        raise HTTPException(400, "说话人编号不合法")
    spk_k = str(spk)
    old_name = ""
    auto_entry = None
    with store.locked():
        meta = store.get(mid)
        if not meta:
            raise HTTPException(404, "会议不存在")
        speakers = dict(meta.get("speakers") or {})
        smeta = copy.deepcopy(meta.get("speaker_meta") or {})
        auto_map = dict(smeta.get("auto") or {})
        auto_entry = auto_map.pop(spk_k, None)
        old_name = str((auto_entry or {}).get("name") or speakers.get(spk_k) or "").strip()
        speakers.pop(spk_k, None)
        smeta["auto"] = auto_map
        if isinstance(smeta.get("suggest"), dict):
            smeta["suggest"].pop(spk_k, None)
        if isinstance(smeta.get("merge_hints"), list):
            smeta["merge_hints"] = [
                h for h in smeta["merge_hints"]
                if not (
                    isinstance(h, dict)
                    and spk_k in {str(x) for x in (h.get("spks") or [])}
                    and (not old_name or str(h.get("name") or "").strip() == old_name)
                )
            ]
        updated = store.update(mid, speakers=speakers, speaker_meta=smeta)
    try:
        if auto_entry and old_name:
            voiceprints.record_override(mid, spk, old_name, "")
        voiceprints.revoke_meeting(mid, spk)
    except Exception:  # noqa: BLE001
        log.debug("undo_rsi_voiceprint hook failed %s", mid, exc_info=True)
    return updated


@app.post("/api/rsi/vocab/suspect/dismiss")
def dismiss_rsi_suspect(body: dict = _RSI_BODY):
    hw = str(body.get("hotword") or "").strip()
    txt = str(body.get("text") or "").strip()
    if not hw or not txt:
        raise HTTPException(400, "缺少热词或待忽略文本")
    rsi_vocab.dismiss_suspect(hw, txt)
    invalidate_derived_caches()
    return {"ok": True}


@app.post("/api/rsi/vocab/rule/restore")
def restore_rsi_rule(body: dict = _RSI_BODY):
    frm = str(body.get("from") or "").strip()
    if not frm:
        raise HTTPException(400, "请指定要恢复的纠错原词")
    if not rsi_vocab.restore_rule(frm):
        raise HTTPException(404, "未找到该已停用规则")
    invalidate_derived_caches(vocab_changed=True)
    return {"ok": True}


@app.post("/api/rsi/vocab/candidate/accept")
def accept_rsi_candidate(body: dict = _RSI_BODY):
    frm = str(body.get("from") or "").strip()
    to = str(body.get("to") or "").strip()
    if not frm or not to or frm == to:
        raise HTTPException(400, "规则不完整")
    res = rsi_vocab.accept_candidate(frm, to, hotword=bool(body.get("hotword")))
    invalidate_derived_caches()
    return res


@app.post("/api/rsi/vocab/candidate/dismiss")
def dismiss_rsi_candidate(body: dict = _RSI_BODY):
    frm = str(body.get("from") or "").strip()
    to = str(body.get("to") or "").strip()
    if not frm or not to:
        raise HTTPException(400, "请提供原词与替换词")
    rsi_vocab.dismiss_candidate(frm, to)
    return {"ok": True}


@app.post("/api/rsi/reset")
def reset_rsi(body: dict = _RSI_BODY):
    scope = str(body.get("scope") or "").strip()
    if scope not in ("all", "voiceprints", "vocab", "ambient"):
        raise HTTPException(400, "重置范围不合法")
    if scope in ("all", "voiceprints"):
        voiceprints.reset()
    if scope in ("all", "vocab"):
        rsi_vocab.reset()
        invalidate_derived_caches(vocab_changed=True)
    if scope in ("all", "ambient"):
        rsi_ambient.reset()
    if scope == "all":
        rsi_events.reset_logs()
    return _rsi_payload()


# ---------------- 跨会关联：相关会议、人物时间线、待办总览与本机 MCP ----------------
@app.get("/api/meetings/{mid}/related")
def get_related_meetings(mid: str, limit: int = 5):
    _meta_or_404(mid)
    return {"mid": mid, "items": relations.related_meetings(mid, limit=limit)}


@app.get("/api/people")
def get_people():
    vp_names = voiceprints.list_person_names()
    items = relations.list_people()
    for item in items:
        item["has_voiceprint"] = item["name"] in vp_names
    return {"people": items}


@app.post("/api/people/rename")
def rename_person_api(body: dict = _RSI_BODY):
    old_name = str(body.get("old_name") or "").strip()
    new_name = str(body.get("new_name") or "").strip()
    update_minutes = bool(body.get("update_minutes"))
    if not old_name:
        raise HTTPException(400, "缺少原人物姓名")
    if not new_name or voiceprints.is_generic_name(new_name):
        raise HTTPException(400, "请输入有效的目标姓名（若需取消命名请使用清除命名）")
    if len(new_name) > 32:
        raise HTTPException(400, "姓名最多 32 个字符")
    if old_name == new_name:
        raise HTTPException(400, "新旧姓名相同")

    metas = store.list_all()
    merged = any(new_name in {str(v or "").strip() for v in (m.get("speakers") or {}).values()} for m in metas)
    updated_records: list[tuple[str, list[str], dict, dict]] = []
    meetings_updated = 0
    minutes_updated = 0

    for meta in metas:
        mid = str(meta.get("id") or "")
        if not mid:
            continue
        sp_preview = meta.get("speakers") or {}
        if not any(str(v or "").strip() == old_name for v in sp_preview.values()):
            continue
        with store.locked():
            cur = store.get(mid)
            if not cur:
                continue
            old_speakers = dict(cur.get("speakers") or {})
            old_smeta = copy.deepcopy(cur.get("speaker_meta") or {})
            new_speakers = dict(old_speakers)
            changed_spks = []
            for spk_k, v in old_speakers.items():
                if str(v or "").strip() == old_name:
                    new_speakers[spk_k] = new_name
                    changed_spks.append(spk_k)
            if not changed_spks:
                continue
            upd: dict = {"speakers": new_speakers}
            new_smeta, mutated_smeta = _clean_speaker_meta(old_speakers, new_speakers, old_smeta)
            if mutated_smeta:
                upd["speaker_meta"] = new_smeta
            eff_meta = store.update(mid, **upd) or {**cur, **upd}
        meetings_updated += 1
        updated_records.append((mid, changed_spks, old_smeta, eff_meta))
        _update_commitments_speaker(mid, old_name, new_name)
        if update_minutes and _replace_minutes_speaker(mid, old_name, new_name):
            minutes_updated += 1
        relations.invalidate_cache(mid)
        invalidate_derived_caches(mid)

    vp_res = voiceprints.rename_person(old_name, new_name)
    migrated_keys: set[tuple[str, str]] = set(vp_res.get("migrated_keys") or set())
    for mid, changed_spks, old_smeta, eff_meta in updated_records:
        auto_before = old_smeta.get("auto") if isinstance(old_smeta.get("auto"), dict) else {}
        for spk_k in changed_spks:
            if spk_k in auto_before:
                voiceprints.record_override(mid, spk_k, old_name, new_name)
            if (mid, spk_k) not in migrated_keys and not rsi_events.is_excluded(eff_meta):
                spk_embs = store.load(mid, "spk_embs.json")
                if spk_embs:
                    voiceprints.enroll(mid, spk_k, new_name, spk_embs)

    return {
        "ok": True,
        "old_name": old_name,
        "new_name": new_name,
        "merged": bool(merged or vp_res.get("merged")),
        "meetings_updated": meetings_updated,
        "minutes_updated": minutes_updated,
        "voiceprint_sessions": voiceprints.person_session_count(new_name),
    }


@app.post("/api/people/reassign")
def reassign_person_meeting_api(body: dict = _RSI_BODY):
    mid = str(body.get("mid") or "").strip()
    old_name = str(body.get("old_name") or "").strip()
    new_name = str(body.get("new_name") or "").strip()
    raw_spks = body.get("spks")
    update_minutes = bool(body.get("update_minutes"))
    if not mid:
        raise HTTPException(400, "缺少会议标识")
    _meta_or_404(mid)
    if not old_name:
        raise HTTPException(400, "缺少原人物姓名")
    if new_name and len(new_name) > 32:
        raise HTTPException(400, "姓名最多 32 个字符")
    spks_filter = {str(x) for x in raw_spks} if isinstance(raw_spks, list) and raw_spks else None
    clearing = not new_name or voiceprints.is_generic_name(new_name)

    with store.locked():
        cur = _meta_or_404(mid)
        old_speakers = dict(cur.get("speakers") or {})
        old_smeta = copy.deepcopy(cur.get("speaker_meta") or {})
        new_speakers = dict(old_speakers)
        changed_spks: list[str] = []
        for spk_k, v in old_speakers.items():
            if str(v or "").strip() == old_name and (spks_filter is None or spk_k in spks_filter):
                new_speakers[spk_k] = "" if clearing else new_name
                changed_spks.append(spk_k)
        if not changed_spks:
            raise HTTPException(404, "这场会议里没有找到该发言人")
        upd: dict = {"speakers": new_speakers}
        new_smeta, mutated_smeta = _clean_speaker_meta(old_speakers, new_speakers, old_smeta)
        if mutated_smeta:
            upd["speaker_meta"] = new_smeta
        eff_meta = store.update(mid, **upd) or {**cur, **upd}

    auto_before = old_smeta.get("auto") if isinstance(old_smeta.get("auto"), dict) else {}
    spk_embs = store.load(mid, "spk_embs.json") if not clearing else None
    for spk_k in changed_spks:
        if spk_k in auto_before:
            voiceprints.record_override(mid, spk_k, old_name, "" if clearing else new_name)
        if clearing:
            voiceprints.revoke_meeting(mid, spk_k)
        elif not rsi_events.is_excluded(eff_meta) and spk_embs:
            voiceprints.enroll(mid, spk_k, new_name, spk_embs)

    _update_commitments_speaker(mid, old_name, "对方" if clearing else new_name)
    if not clearing and update_minutes:
        _replace_minutes_speaker(mid, old_name, new_name)
    relations.invalidate_cache(mid)
    invalidate_derived_caches(mid)
    return {"ok": True, "mid": mid, "meta": eff_meta}


@app.post("/api/people/clear")
def clear_person_api(body: dict = _RSI_BODY):
    target_name = str(body.get("name") or "").strip()
    if not target_name:
        raise HTTPException(400, "缺少人物姓名")
    metas = store.list_all()
    meetings_updated = 0
    for meta in metas:
        mid = str(meta.get("id") or "")
        if not mid:
            continue
        sp_preview = meta.get("speakers") or {}
        if not any(str(v or "").strip() == target_name for v in sp_preview.values()):
            continue
        with store.locked():
            cur = store.get(mid)
            if not cur:
                continue
            old_speakers = dict(cur.get("speakers") or {})
            old_smeta = copy.deepcopy(cur.get("speaker_meta") or {})
            new_speakers = dict(old_speakers)
            changed_spks = []
            for spk_k, v in old_speakers.items():
                if str(v or "").strip() == target_name:
                    new_speakers[spk_k] = ""
                    changed_spks.append(spk_k)
            if not changed_spks:
                continue
            upd: dict = {"speakers": new_speakers}
            new_smeta, mutated_smeta = _clean_speaker_meta(old_speakers, new_speakers, old_smeta)
            if mutated_smeta:
                upd["speaker_meta"] = new_smeta
            store.update(mid, **upd)
        auto_before = old_smeta.get("auto") if isinstance(old_smeta.get("auto"), dict) else {}
        for spk_k in changed_spks:
            if spk_k in auto_before:
                voiceprints.record_override(mid, spk_k, target_name, "")
        _update_commitments_speaker(mid, target_name, "对方")
        relations.invalidate_cache(mid)
        invalidate_derived_caches(mid)
        meetings_updated += 1

    vp_deleted = voiceprints.delete_person(target_name)
    return {
        "ok": True,
        "name": target_name,
        "meetings_updated": meetings_updated,
        "voiceprint_deleted": vp_deleted,
    }


@app.get("/api/people/{name:path}")
def get_person_timeline(name: str):
    res = relations.person_timeline(name)
    res["voiceprint_sessions"] = voiceprints.person_session_count(name)
    return res


@app.get("/api/todos")
def get_todos(status: str = "open", person: str = "", limit: int = 200):
    return relations.list_todos(status=status, person=person, limit=limit)


@app.post("/api/todos/toggle")
def toggle_todo_api(body: dict = _RSI_BODY):
    mid = str(body.get("mid") or "").strip()
    if not mid:
        raise HTTPException(400, "缺少会议标识")
    _meta_or_404(mid)
    raw_idx = body.get("idx")
    if isinstance(raw_idx, bool) or raw_idx is None:
        raise HTTPException(400, "待办序号格式不正确")
    try:
        idx = int(raw_idx)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "待办序号格式不正确") from e
    done = bool(body.get("done"))
    try:
        res = relations.toggle_todo(mid, idx, done)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from None
    except (ValueError, IndexError) as e:
        raise HTTPException(400, str(e)) from None
    invalidate_derived_caches(mid)
    return res


@app.get("/api/mcp/config")
def get_mcp_config():
    base = str(store.BASE.resolve())
    cfg = {
        "mcpServers": {
            "meeting-notes": {
                "command": "uv",
                "args": ["run", "--directory", base, "python", "mcp_server.py"],
            }
        }
    }
    return {
        "server_path": str((store.BASE / "mcp_server.py").resolve()),
        "workspace": base,
        "config": cfg,
        "tools": ["list_meetings", "search_meetings", "get_meeting", "get_related_meetings", "get_person_history", "list_todos"],
    }


@app.post("/api/meetings/{mid}/brief")
async def generate_meeting_brief(mid: str, body: dict = Body(default={})):
    _meta_or_404(mid)
    prov = _active_prov_optional(body.get("provider"))
    res = await insights.generate_brief(mid, prov)
    if not res:
        raise HTTPException(400, "还没有可用的转写内容")
    invalidate_derived_caches(mid)
    return res


@app.post("/api/insights/backfill")
async def backfill_briefs(body: dict = Body(default={})):
    raw_limit = body.get("limit", 5)
    try:
        limit = max(1, min(10, int(raw_limit)))
    except (TypeError, ValueError):
        limit = 5
    prov = _active_prov_optional(body.get("provider"))
    updated: list[str] = []
    for meta in store.list_all():
        if len(updated) >= limit:
            break
        mid = str(meta.get("id") or "")
        if meta.get("status") != ms.READY or rsi_events.is_excluded(meta) or meta.get("brief"):
            continue
        paras = _paras(mid)
        if not paras or sum(len(str(p.get("text") or "")) for p in paras) < 40:
            continue
        res = await insights.generate_brief(mid, prov, paras=paras)
        if res:
            invalidate_derived_caches(mid)
            updated.append(mid)
    return {"updated": updated, "count": len(updated)}


@app.get("/api/rsi/voiceprints/clusters")
def get_voiceprint_clusters(days: int = 14, limit: int = 8):
    return voiceprints.cluster_unnamed_speakers(days=max(0, min(90, int(days if days is not None else 14))), limit=limit)


@app.post("/api/rsi/voiceprints/batch-name")
def batch_name_voiceprint_cluster(body: dict = _RSI_BODY):
    name = str(body.get("name") or "").strip()
    members = body.get("members")
    try:
        res = voiceprints.batch_name_cluster(name, members if isinstance(members, list) else [])
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    invalidate_derived_caches()
    return res


@app.get("/api/commitments")
def get_commitments(status: str = "open", days: int = 14):
    if status not in ("open", "done", "all"):
        raise HTTPException(400, "筛选状态不合法")
    return insights.list_commitments(status=status, days=max(0, min(90, int(days if days is not None else 14))))


@app.post("/api/commitments/toggle")
def toggle_commitment_api(body: dict = _RSI_BODY):
    mid = str(body.get("mid") or "").strip()
    cid = str(body.get("id") or "").strip()
    if not mid or not cid:
        raise HTTPException(400, "参数不完整，缺少会议或约定编号")
    _meta_or_404(mid)
    res = insights.toggle_commitment(mid, cid, bool(body.get("done")))
    if res is None:
        raise HTTPException(404, "未找到该待跟进约定")
    return res


@app.post("/api/commitments/dismiss")
def dismiss_commitment_api(body: dict = _RSI_BODY):
    mid = str(body.get("mid") or "").strip()
    cid = str(body.get("id") or "").strip()
    if not mid or not cid:
        raise HTTPException(400, "参数不完整，缺少会议或承诺编号")
    _meta_or_404(mid)
    if not insights.dismiss_commitment(mid, cid):
        raise HTTPException(404, "未找到该待跟进约定")
    return {"ok": True}


@app.post("/api/commitments/restore")
def restore_commitment_api(body: dict = _RSI_BODY):
    mid = str(body.get("mid") or "").strip()
    cid = str(body.get("id") or "").strip()
    if not mid or not cid:
        raise HTTPException(400, "参数不完整，缺少会议或承诺编号")
    _meta_or_404(mid)
    if not insights.restore_commitment(mid, cid):
        raise HTTPException(404, "未找到该待跟进约定")
    return {"ok": True}


@app.post("/api/ask-global")
async def ask_global_api(body: dict = _RSI_BODY):
    q = str(body.get("q") or body.get("question") or "").strip()
    if not q:
        raise HTTPException(400, "请输入要询问的问题")
    prov = _prov(body["provider"]) if body.get("provider") else _active_prov_optional()
    return await insights.global_ask(q, prov)


@app.get("/api/projects")
def get_projects(days: int = 30, limit: int = 12):
    return {"projects": relations.list_projects(days=max(0, min(180, int(days if days is not None else 30))), limit=limit)}


@app.get("/api/weekly")
def get_weekly(end: str = ""):
    if end:
        _check_date(end)
    return insights.collect_week_data(end or None)


@app.post("/api/weekly/draft")
def build_weekly_draft_api(body: dict = Body(default={})):
    end = str(body.get("end") or "").strip()
    if end:
        _check_date(end)
    data = insights.collect_week_data(end or None)
    if not data["meetings"] and not data["daily_summaries"]:
        raise HTTPException(400, "这一周还没有可汇总的记录")
    md = insights.build_local_weekly_markdown(data)
    rec = insights.save_weekly_report(
        data["week_id"],
        {
            "week_id": data["week_id"],
            "start_date": data["start_date"],
            "end_date": data["end_date"],
            "markdown": md,
            "provider": "本机摘要拼接",
            "model": "local-draft",
            "created": datetime.now().isoformat(timespec="seconds"),
            "cost": 0.0,
        },
    )
    return {"report": rec}


@app.post("/api/weekly/generate")
async def generate_weekly_api(body: dict = Body(default={})):
    end = str(body.get("end") or "").strip()
    if end:
        _check_date(end)
    prov = _prov(body.get("provider"))
    return StreamingResponse(insights.weekly_gen_stream(end or None, prov), media_type="application/x-ndjson")


# ---------------- 本地 AI 模型（llama-server） ----------------
LLM_SCRIPT = store.BASE / "scripts" / "start-local-llm.sh"
LLM_LOG = store.DATA / "local-llm.log"
_llm: dict = {"proc": None}
_llm_lock = asyncio.Lock()


def _local_url() -> str:
    for p in store.get_settings().get("providers", []):
        if p["id"] == "local":
            return p["base_url"]
    return "http://127.0.0.1:8090/v1"


def _local_llm_launch() -> tuple[list[str] | None, bool]:
    """返回 (启动命令, 是否可执行)。支持 LOCAL_LLM_CMD / LOCAL_LLM_SCRIPT 覆盖。"""
    cmd_env = (os.environ.get("LOCAL_LLM_CMD") or "").strip()
    if cmd_env:
        parts = shlex.split(cmd_env, posix=(os.name != "nt"))
        if parts:
            exe = parts[0]
            if Path(exe).exists() or shutil.which(exe):
                return parts, True
            return parts, False
    script_env = (os.environ.get("LOCAL_LLM_SCRIPT") or "").strip()
    script = Path(script_env) if script_env else LLM_SCRIPT
    if not script.exists():
        return None, False
    if os.name == "nt":
        suf = script.suffix.lower()
        if suf in (".bat", ".cmd"):
            return ["cmd", "/c", str(script)], True
        if suf == ".ps1":
            ps = shutil.which("powershell") or shutil.which("pwsh")
            return ([ps, "-ExecutionPolicy", "Bypass", "-File", str(script)], True) if ps else (None, False)
        bash = shutil.which("bash")
        return ([bash, str(script)], True) if bash else (None, False)
    bash = shutil.which("bash")
    return ([bash, str(script)], True) if bash else (None, False)


def _tail_file(path: Path, max_bytes: int = 8192) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            raw = f.read()
    except OSError:
        return ""
    lines = [ln for ln in raw.decode("utf-8", "ignore").splitlines() if ln.strip()]
    return "\n".join(lines[-3:])[-400:]


def _stop_local_llm():
    p = _llm["proc"]
    if p and p.poll() is None:
        if os.name == "nt" or not hasattr(os, "killpg"):
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                                   capture_output=True, timeout=10,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                else:
                    p.kill()
            except Exception:  # noqa: BLE001
                with contextlib.suppress(Exception):
                    p.kill()
            with contextlib.suppress(Exception):
                p.wait(timeout=5)
        else:
            try:
                os.killpg(p.pid, signal.SIGTERM)
                p.wait(timeout=10)
            except Exception:  # noqa: BLE001
                with contextlib.suppress(Exception):
                    os.killpg(p.pid, signal.SIGKILL)
                with contextlib.suppress(Exception):
                    p.wait(timeout=5)
    _llm["proc"] = None


def _start_local_llm(cmd: list[str], env: dict[str, str], popen_kw: dict) -> subprocess.Popen:
    LLM_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LLM_LOG, "w", encoding="utf-8") as log_f:
        return subprocess.Popen(cmd, stdout=log_f, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env, **popen_kw)


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
    tail = await asyncio.to_thread(_tail_file, LLM_LOG) if LLM_LOG.exists() else ""
    exited = p.returncode if p and not ours else None
    _, runnable = _local_llm_launch()
    return {"script": runnable, "url": url, "running": running, "starting": ours and not running,
            "ours": ours, "exit_code": exited, "log": tail}


@app.post("/api/llm/local")
async def local_llm_action(request: Request, body: dict = Body(...)):
    lan._only_here(request)
    act = body.get("action")
    async with _llm_lock:
        if act == "start":
            st = await local_llm_status()
            if st["running"] or st["ours"]:
                return st
            cmd, runnable = _local_llm_launch()
            if not runnable or not cmd:
                raise HTTPException(400, "未找到本地大模型启动脚本，请先完成本地模型部署")
            port = re.search(r":(\d+)", _local_url().split("//", 1)[-1])
            env = {**os.environ, "PORT": port.group(1) if port else "8090"}
            popen_kw: dict = {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)} if os.name == "nt" else {"start_new_session": True}
            try:
                _llm["proc"] = await asyncio.to_thread(_start_local_llm, cmd, env, popen_kw)
            except OSError as e:
                raise HTTPException(400, _friendly_error(e, "启动本地模型失败")) from e
            log.info("local llm started pid=%s", _llm["proc"].pid)
            await asyncio.sleep(1)
        elif act == "stop":
            p = _llm["proc"]
            if not (p and p.poll() is None):
                raise HTTPException(400, "该本地模型由外部程序启动，请前往原工具中关闭")
            await asyncio.to_thread(_stop_local_llm)
        else:
            raise HTTPException(400, "未知操作")
    return await local_llm_status()


# ---------------- 搜索 ----------------
_search_lock = threading.Lock()
_search_cache: OrderedDict[str, tuple[tuple, list[str]]] = OrderedDict()
_SEARCH_CACHE_MAX = 500


def _search_texts(mid: str, vocab_sig: tuple | None) -> list[str]:
    d = store.mdir(mid)
    sig = (
        store._stat_sig(d / "transcript.json"),
        store._stat_sig(d / "live.json"),
        store._stat_sig(d / "notes.md"),
        store._stat_sig(d / "minutes.json"),
        vocab_sig,
    )
    with _search_lock:
        hit = _search_cache.get(mid)
        if hit is not None and hit[0] == sig:
            _search_cache.move_to_end(mid)
            return hit[1]
    texts = [p["text"] for p in _paras(mid)] + [_notes(mid), (store.load(mid, "minutes.json") or {}).get("markdown", "")]
    with _search_lock:
        _search_cache[mid] = (sig, texts)
        _search_cache.move_to_end(mid)
        while len(_search_cache) > _SEARCH_CACHE_MAX:
            _search_cache.popitem(last=False)
    return texts


@app.get("/api/search")
def search(q: str = ""):
    """按标题、转写、笔记、纪要搜索，返回每条记录的命中数和一小段上下文。"""
    q = q.strip()
    if not q:
        return []
    ql = q.lower()
    rsi_sig = None
    try:
        rsi_sig = rsi_vocab.stats_sig()
    except Exception:  # noqa: BLE001
        pass
    vocab_sig = (store._stat_sig(vocab.PATH), rsi_sig)
    out = []
    for m in store.list_all():
        mid = m["id"]
        texts = _search_texts(mid, vocab_sig)
        hits, snip = 0, ""
        for t in texts:
            tl = t.lower()
            n = tl.count(ql)
            if n and not snip:
                i = tl.find(ql)
                snip = ("…" if i > 18 else "") + t[max(0, i - 18): i + len(q) + 30].replace("\n", " ")
            hits += n
        if hits or ql in str(m.get("title") or "").lower():
            out.append({"id": mid, "hits": hits, "snippet": snip})
    return out


# ---------------- 每日汇总 ----------------
def _check_date(date: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError as e:
        raise HTTPException(400, "日期无效，应为 YYYY-MM-DD") from e
    return date


def _day_meetings(date: str) -> list[dict]:
    return store.list_by_date(date)


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
        notes = _notes(m["id"]).strip()
        # 纪要生成后转写改过（改名、改字、续录）的话用转写，免得汇总里是旧名字、漏内容
        mn = "" if "transcript" in _minutes_stale(m["id"], m, mrec, paras=paras, notes=notes) else mrec.get("markdown", "")
        if mn:
            body = "（已整理的纪要）\n" + mn
        else:
            body = "\n".join(f"[{_hm(_wall(m, seg, p['start']))}] {prompts.spk_name(m, p['spk']) if p['spk'] >= 0 else ''}："
                             f"{p['text']}" for p in paras)
        blocks.append(head + ("\n用户笔记：" + notes if notes else "") + "\n" + body)
    return blocks


_daily_locks: dict[str, asyncio.Lock] = {}


def _daily_lock(date: str) -> asyncio.Lock:
    lk = _daily_locks.get(date)
    if lk is None:
        if len(_daily_locks) > 64:
            for k in [x for x, v in _daily_locks.items() if not v.locked()]:
                _daily_locks.pop(k, None)
        lk = _daily_locks[date] = asyncio.Lock()
    return lk


async def daily_gen(date: str, prov: dict):
    t0 = time.time()
    async with _daily_lock(date):
        metas, blocks = await asyncio.to_thread(lambda: (ms_ := _day_meetings(date), _day_blocks(ms_)))
        if not blocks:
            yield _ndjson({"type": "error", "msg": "这一天没有可汇总的转写内容"})
            return
        src_hash = _hash("\n\n".join(blocks))
        budget = max(2000, int(prov.get("max_input_chars") or 60000) - 3000)
        out = ""
        try:
            if sum(len(b) + 2 for b in blocks) > budget:
                per = max(400, int(budget * 0.9 / len(blocks)))
                sem = asyncio.Semaphore(1 if llm.is_local_url(prov.get("base_url") or "") else 4)
                chunk_budget = max(1000, int(budget * 0.8))

                async def _condense(b: str) -> str:
                    if len(b) <= per:
                        return b
                    head, *lines = b.split("\n")
                    chunks = prompts.chunk_lines(lines, chunk_budget)

                    async def _one(ch: list[str]) -> str:
                        async with sem:
                            return await chat(prov, [{"role": "user", "content": prompts.DAY_MAP_PROMPT.format(
                                n=max(150, per // max(1, len(chunks))), text=head + "\n" + "\n".join(ch))}], max_tokens=1500)

                    parts = await asyncio.gather(*(_one(ch) for ch in chunks))
                    return head + "\n" + "\n".join(p.strip() for p in parts)

                yield _ndjson({"type": "status", "msg": f"内容较多，正在分段提炼（共 {len(blocks)} 段）…"})
                blocks = list(await asyncio.gather(*(_condense(b) for b in blocks)))
                # 分段提炼后若总长仍超预算（例如当天碎片对话极多），按比例截断确保不超模型上下文上限
                if sum(len(b) + 2 for b in blocks) > budget:
                    cap = max(120, int(budget * 0.95 / len(blocks)))
                    blocks = [b[:cap] for b in blocks]
            d = datetime.strptime(date, "%Y-%m-%d")
            label = f"{d.month}月{d.day}日 周{'一二三四五六日'[d.weekday()]}"
            msgs = prompts.daily_messages(label, vocab.hotwords(), blocks)
            yield _ndjson({"type": "status", "msg": f"{prov['name']} 生成中…"})
            async for kind, delta in chat_events(prov, msgs, max_tokens=4000):
                if kind == "think":
                    yield _ndjson({"type": "status", "msg": f"{prov['name']} 正在思考，已 {delta} 秒"})
                    continue
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
            yield _ndjson({"type": "error", "msg": _friendly_error(e, "生成今日日报时出错，请稍后再试")})


@app.get("/api/days/{date}")
def get_day(date: str):
    _check_date(date)
    metas = _day_meetings(date)
    for m in metas:
        seg = store.load(m["id"], "segmap.json")
        m["clock_start"] = _hm(_wall(m, seg, 0))
        m["clock_end"] = (m.get("ended_at") or "")[11:16] or _hm(_wall(m, seg, int(m.get("duration", 0) * 1000)))
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


AUTO_DAILY: dict[str, dict] = {}


async def _housekeeping():
    """每分钟：到点自动生成当日汇总；每小时：清理过期的自动记录录音。
    自动汇总：到点后生成一次。到点前手动生成过、之后又有新内容的，到点再重新生成；
    没配 Key 时每分钟再看一次（配好后自动补上）；接口出错隔 30 分钟重试，最多 3 次。失败原因写进 daily/<日期>.auto.json，当日页面显示。"""
    auto = AUTO_DAILY  # 日期 → {"tries", "next", "done"}；放在模块里，/api/state 能看到
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
            hm = _parse_hhmm(cfg.get("summary_time") or "")
            if not cfg.get("enabled") or hm is None:
                continue
            now = datetime.now()
            date = now.strftime("%Y-%m-%d")
            for old_d in [k for k in auto if k != date]:
                auto.pop(old_d, None)
            h, mi = hm
            s = auto.setdefault(date, {"tries": 0, "next": 0.0, "done": False})
            if (now.hour, now.minute) < (h, mi) or s["done"] or time.time() < s["next"]:
                continue
            rec = store.read_json(DAILY / f"{date}.json")
            due = now.replace(hour=h, minute=mi, second=0, microsecond=0).timestamp()
            if rec:
                try:
                    if datetime.fromisoformat(rec.get("created") or "").timestamp() >= due:
                        s["done"] = True  # 到点后已经生成过（自动或手动）
                        continue
                except (ValueError, TypeError):
                    pass
            metas = await asyncio.to_thread(_day_meetings, date)
            if not metas:
                continue
            if any(m["status"] in ms.ACTIVE for m in metas) and (now.hour, now.minute) < (23, 40):
                continue  # 等正在记录/转写的结束，否则汇总里是临时文字、还会漏掉后半段
            blocks = await asyncio.to_thread(_day_blocks, metas)
            if not blocks:
                continue  # 当天只有空/失败会议时不算失败，等后续有可汇总内容再触发
            if rec and rec.get("src_hash") == _hash("\n\n".join(blocks)):
                s["done"] = True  # 早先手动生成的汇总已经包含全部内容
                continue
            if _daily_lock(date).locked():
                continue  # 手动汇总正在跑，不重复触发
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


class _NoCacheStatic(StaticFiles):
    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        if path.endswith((".js", ".mjs", ".css")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", _NoCacheStatic(directory=store.BASE / "static"), name="static")
