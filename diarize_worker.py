"""说话人分离子进程：pyannote community-1（自带重叠检测和 VBx 聚类，选法和测试结果见 docs/improvements.md 第 4 项）。

  python diarize_worker.py <wav> <结果.json> [人数，0 = 自动]

结果：{"turns": [[开始ms, 结束ms, 说话人], ...]}，每个时刻只有一个人（exclusive_speaker_diarization，专门给对齐文字用的）。

为什么单独开进程：模型要用 GPU（CPU 上 26 分钟的录音 15 分钟都跑不完），整段一次跑完要一两分钟；
放在服务进程里就得一直占着 GPU 锁（MPS 不能在同一进程里多线程并用），这期间实时转写会卡住。不同进程可以同时用 MPS。

隐私：pyannote 默认会把用法统计（音频时长、人数、会话 id）发到 otel.pyannote.ai，这里在导入前强制关掉；
模型从 ModelScope 下载一次（约 31 MB，和 Hugging Face 上 pyannote-community 的文件逐字节相同），之后只从本地目录加载，不再联网。
"""
import contextlib
import json
import os
import sys
import time
import traceback

os.environ["PYANNOTE_METRICS_ENABLED"] = "false"  # 必须在导入 pyannote.audio 之前
MODEL = "pyannote/speaker-diarization-community-1"


def _find_cached_dir() -> str | None:
    try:
        from modelscope import snapshot_download
        p = snapshot_download(MODEL, local_files_only=True)
        if p and os.path.isdir(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    try:
        import model_manager
        local_dir = model_manager.find_local_model_dir("pyannote-community-1")
        if local_dir is not None:
            return str(local_dir)
    except Exception:  # noqa: BLE001
        pass
    return None


def model_dir(local_only: bool = False) -> str:
    cached = _find_cached_dir()
    if cached:
        return cached
    if local_only:
        raise FileNotFoundError(f"{MODEL} not found in local cache")
    from modelscope import snapshot_download
    return snapshot_download(MODEL)


def _detect_device() -> str:
    import torch
    return "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"


def _load_pipeline():
    import torch
    from pyannote.audio import Pipeline

    t = time.time()
    dev = _detect_device()
    pipe = Pipeline.from_pretrained(model_dir())
    pipe.to(torch.device(dev))
    return pipe, dev, time.time() - t


def _infer(pipe, dev: str, wav: str, num_spk: int = 0) -> dict:
    import soundfile as sf
    import torch

    t = time.time()
    x, sr = sf.read(wav, dtype="float32")
    if x.ndim > 1:
        x = x[:, 0]
    kw = {"num_speakers": int(num_spk)} if num_spk and num_spk > 0 else {}
    r = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": sr}, **kw)
    names: dict = {}
    turns = [[int(seg.start * 1000), int(seg.end * 1000), names.setdefault(spk, len(names))]
             for seg, _, spk in r.exclusive_speaker_diarization.itertracks(yield_label=True) if seg.end > seg.start]
    return {"turns": turns, "device": dev, "run_s": round(time.time() - t, 1)}


def diarize(wav: str, num_spk: int = 0) -> dict:
    pipe, dev, t_load = _load_pipeline()
    res = _infer(pipe, dev, wav, num_spk)
    return {
        "turns": res["turns"],
        "device": res["device"],
        "load_s": round(t_load, 1),
        "run_s": res["run_s"],
    }


def _probe() -> int:
    try:
        dev = _detect_device()
        cached = _find_cached_dir() is not None
        print(json.dumps({"ok": True, "worker": "pyannote", "device": dev, "cached": cached}), flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "worker": "pyannote", "error": f"{type(e).__name__}: {e}"}), flush=True)
        return 1


def _serve() -> int:
    proto_out = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj: dict) -> None:
        proto_out.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto_out.flush()

    try:
        with contextlib.redirect_stdout(sys.stderr):
            pipe, dev, t_load = _load_pipeline()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit({"ready": False, "worker": "pyannote", "error": f"{type(e).__name__}: {e}"})
        return 1

    emit({"ready": True, "worker": "pyannote", "device": dev, "load_s": round(t_load, 1)})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"id": None, "ok": False, "error": f"invalid json: {e}"})
            continue
        if not isinstance(req, dict):
            emit({"id": None, "ok": False, "error": "request must be a JSON object"})
            continue

        req_id = req.get("id")
        cmd = req.get("cmd")
        if cmd == "ping":
            emit({"id": req_id, "ok": True, "pong": True, "worker": "pyannote", "device": dev})
            continue
        if cmd == "shutdown":
            emit({"id": req_id, "ok": True, "shutdown": True})
            break
        if cmd not in (None, "diarize"):
            emit({"id": req_id, "ok": False, "error": f"unknown cmd: {cmd}"})
            continue

        wav = req.get("wav")
        if not wav or not isinstance(wav, str):
            emit({"id": req_id, "ok": False, "error": "missing wav path"})
            continue
        try:
            num_spk = int(req.get("num_spk") or 0)
            with contextlib.redirect_stdout(sys.stderr):
                res = _infer(pipe, dev, wav, num_spk)
            res["load_s"] = 0.0
            emit({"id": req_id, "ok": True, "result": res})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            emit({"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--probe":
        raise SystemExit(_probe())
    if len(sys.argv) >= 2 and sys.argv[1] == "--serve":
        raise SystemExit(_serve())
    res = diarize(sys.argv[1], int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    with open(sys.argv[2], "w") as f:
        json.dump(res, f)
