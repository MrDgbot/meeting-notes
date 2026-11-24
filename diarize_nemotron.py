"""可选的说话人分离子进程：NVIDIA Nemotron 3 Diarization（约 100M 参数，OpenMDW-1.1）。

  python diarize_nemotron.py <wav> <结果.json> [人数，0 = 自动]

设置里选了「Nemotron 3」才由 asr_engine 调用。模型第一次用时从 Hugging Face 下载（约 400MB），
之后只读本机缓存。默认仍是 CAM++：这个模型的训练数据含 AISHELL-4，近场会议还没验证过。
失败时调用方退回 CAM++。

输出的时间段可以重叠（同一时刻两个人都在说话）。设备优先 CUDA，其次 Apple MPS，否则 CPU，用 float32。
"""
import json
import os
import sys
import time

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"  # 必须在导入 transformers / huggingface_hub 之前
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # 必须在导入 torch 之前
MODEL = "nvidia/Nemotron-3-Diarization"


def _load_model(model_id: str = MODEL):
    import torch
    from transformers import AutoModelForAudioFrameClassification, AutoProcessor

    try:
        processor = AutoProcessor.from_pretrained(model_id, local_files_only=True)
        model = AutoModelForAudioFrameClassification.from_pretrained(
            model_id, dtype=torch.float32, local_files_only=True
        )
        return processor, model
    except Exception:  # noqa: BLE001  本机缓存里还没有时才联网下载
        pass
    try:
        processor = AutoProcessor.from_pretrained(model_id)
        model = AutoModelForAudioFrameClassification.from_pretrained(model_id, dtype=torch.float32)
        return processor, model
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(
            "加载 Nemotron 3 Diarization 失败。确认能访问 Hugging Face，或事先把模型放进缓存。"
            f"原始错误：{type(e).__name__}: {e}"
        ) from e


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


def diarize(wav: str, num_spk: int = 0) -> dict:
    import soundfile as sf
    import torch

    import diar_overlap

    t = time.time()
    dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    processor, model = _load_model(MODEL)
    try:
        model.to(dev)
    except Exception:  # noqa: BLE001
        dev = "cpu"
        model.to("cpu")
    model.eval()
    t_load = time.time() - t
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
    return {"turns": [[int(a), int(b), int(s)] for a, b, s in turns], "device": dev,
            "load_s": round(t_load, 1), "run_s": round(time.time() - t - t_load, 1),
            "speakers": len({s for _, _, s in turns})}


if __name__ == "__main__":
    res = diarize(sys.argv[1], int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    with open(sys.argv[2], "w") as f:
        json.dump(res, f)
