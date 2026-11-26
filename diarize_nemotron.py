"""可选的说话人分离子进程：NVIDIA Nemotron 3 Diarization（约 100M 参数，OpenMDW-1.1）。

  python diarize_nemotron.py <wav> <结果.json> [人数，0 = 自动]

设置里选了「Nemotron 3」才由 asr_engine 调用。模型第一次用时从 Hugging Face 下载（约 400MB），
之后只读本机缓存。默认仍是 CAM++：这个模型的训练数据含 AISHELL-4，近场会议还没验证过。
失败时调用方退回 CAM++。

输出的时间段可以重叠（同一时刻两个人都在说话）。设备优先 CUDA，其次 Apple MPS，否则 CPU，用 float32。
"""
import contextlib
import json
import os
import sys
import time
import traceback

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"  # 必须在导入 transformers / huggingface_hub 之前
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # 必须在导入 torch 之前
MODEL = "nvidia/Nemotron-3-Diarization"


def _load_from_source(AutoProcessor, AutoModelForAudioFrameClassification, target: str, torch, *, local_only: bool):
    kw = {"local_files_only": True} if local_only else {}
    processor = AutoProcessor.from_pretrained(target, **kw)
    model = AutoModelForAudioFrameClassification.from_pretrained(target, dtype=torch.float32, **kw)
    return processor, model


def _find_cached_dir() -> str | None:
    try:
        import model_manager
        local_dir = model_manager.find_local_model_dir("nemotron-3-diarization")
        if local_dir is not None:
            return str(local_dir)
    except Exception:  # noqa: BLE001
        pass
    try:
        from huggingface_hub import snapshot_download
        p = snapshot_download(MODEL, local_files_only=True)
        if p and os.path.isdir(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    try:
        from modelscope import snapshot_download as ms_snapshot_download
        p = ms_snapshot_download(MODEL, local_files_only=True)
        if p and os.path.isdir(p):
            return p
    except Exception:  # noqa: BLE001
        pass
    return None


def _load_model(model_id: str = MODEL):
    import torch
    import transformers
    from transformers import AutoModelForAudioFrameClassification, AutoProcessor

    try:
        return _load_from_source(
            AutoProcessor, AutoModelForAudioFrameClassification, model_id, torch, local_only=True
        )
    except Exception:  # noqa: BLE001  本机缓存里还没有时才继续查自定义目录/联网下载
        pass

    try:
        import model_manager
        local_dir = model_manager.find_local_model_dir("nemotron-3-diarization")
        if local_dir is not None:
            return _load_from_source(
                AutoProcessor, AutoModelForAudioFrameClassification, str(local_dir), torch, local_only=True
            )
    except Exception:  # noqa: BLE001
        pass

    last_err: Exception | None = None
    try:
        return _load_from_source(
            AutoProcessor, AutoModelForAudioFrameClassification, model_id, torch, local_only=False
        )
    except Exception as e:  # noqa: BLE001
        last_err = e

    # HF 失败后尝试 ModelScope 兜底（若 transformers 是单测注入的假命名空间且 modelscope 是真库则不触发真实联网）
    try:
        import modelscope
        ms_download = getattr(modelscope, "snapshot_download", None)
        if callable(ms_download):
            ms_dir = None
            try:
                ms_dir = ms_download(model_id, local_files_only=True)
            except Exception:  # noqa: BLE001
                tf_is_mock = getattr(transformers, "__file__", None) is None
                ms_is_mock = getattr(modelscope, "__file__", None) is None
                if not tf_is_mock or ms_is_mock:
                    ms_dir = ms_download(model_id)
            if ms_dir and os.path.isdir(str(ms_dir)):
                return _load_from_source(
                    AutoProcessor, AutoModelForAudioFrameClassification, str(ms_dir), torch, local_only=True
                )
    except Exception as e:  # noqa: BLE001
        last_err = e

    raise RuntimeError(
        "加载 Nemotron 3 Diarization 失败。确认能访问 Hugging Face，或事先把模型放进缓存。"
        f"原始错误：{type(last_err).__name__}: {last_err}"
    ) from last_err


def _prepare_inputs(inputs, dev: str, torch) -> dict:
    float_inputs = {}
    for k, v in inputs.items():
        if hasattr(v, "to"):
            if hasattr(v, "is_floating_point") and v.is_floating_point():
                float_inputs[k] = v.to(device=dev, dtype=torch.float32)
            else:
                float_inputs[k] = v.to(device=dev)
        else:
            float_inputs[k] = v
    return float_inputs


def _detect_device() -> str:
    import torch
    return "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"


def _infer(processor, model, dev: str, wav: str, num_spk: int = 0) -> tuple[dict, str]:
    import soundfile as sf
    import torch

    import diar_overlap

    t = time.time()
    x, sr = sf.read(wav, dtype="float32")
    if getattr(x, "ndim", 1) > 1:
        x = x[:, 0]
    if int(sr) != 16000:
        raise RuntimeError(f"需要 16kHz 单声道，得到 {sr}Hz")
    inputs = processor(x, sampling_rate=16000, return_tensors="pt")
    try:
        float_inputs = _prepare_inputs(inputs, dev, torch)
        with torch.inference_mode():
            logits = model(**float_inputs).logits
    except (NotImplementedError, RuntimeError):  # MPS 上个别算子不支持或推理失败时退回 CPU
        if dev == "cpu":
            raise
        dev = "cpu"
        model.to("cpu")
        float_inputs = _prepare_inputs(inputs, "cpu", torch)
        with torch.inference_mode():
            logits = model(**float_inputs).logits
    probs = torch.sigmoid(logits[0]).float().cpu().numpy()
    turns = diar_overlap.limit_speakers(diar_overlap.probs_to_turns(probs), num_spk)
    return {
        "turns": [[int(a), int(b), int(s)] for a, b, s in turns],
        "device": dev,
        "run_s": round(time.time() - t, 1),
        "speakers": len({s for _, _, s in turns}),
    }, dev


def diarize(wav: str, num_spk: int = 0) -> dict:
    t = time.time()
    dev = _detect_device()
    processor, model = _load_model(MODEL)
    try:
        model.to(dev)
    except Exception:  # noqa: BLE001
        dev = "cpu"
        model.to("cpu")
    model.eval()
    t_load = time.time() - t
    res, _ = _infer(processor, model, dev, wav, num_spk)
    return {
        "turns": res["turns"],
        "device": res["device"],
        "load_s": round(t_load, 1),
        "run_s": res["run_s"],
        "speakers": res["speakers"],
    }


def _probe() -> int:
    try:
        dev = _detect_device()
        cached = _find_cached_dir() is not None
        print(json.dumps({"ok": True, "worker": "nemotron", "device": dev, "cached": cached}), flush=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "worker": "nemotron", "error": f"{type(e).__name__}: {e}"}), flush=True)
        return 1


def _serve() -> int:
    proto_out = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj: dict) -> None:
        proto_out.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto_out.flush()

    try:
        with contextlib.redirect_stdout(sys.stderr):
            t = time.time()
            dev = _detect_device()
            processor, model = _load_model(MODEL)
            try:
                model.to(dev)
            except Exception:  # noqa: BLE001
                dev = "cpu"
                model.to("cpu")
            model.eval()
            t_load = time.time() - t
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit({"ready": False, "worker": "nemotron", "error": f"{type(e).__name__}: {e}"})
        return 1

    emit({"ready": True, "worker": "nemotron", "device": dev, "load_s": round(t_load, 1)})

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
            emit({"id": req_id, "ok": True, "pong": True, "worker": "nemotron", "device": dev})
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
                res, dev = _infer(processor, model, dev, wav, num_spk)
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
