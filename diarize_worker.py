"""说话人分离子进程：pyannote community-1（自带重叠检测和 VBx 聚类，选法和测试结果见 docs/improvements.md 第 4 项）。

  python diarize_worker.py <wav> <结果.json> [人数，0 = 自动]

结果：{"turns": [[开始ms, 结束ms, 说话人], ...]}，每个时刻只有一个人（exclusive_speaker_diarization，专门给对齐文字用的）。

为什么单独开进程：模型要用 GPU（CPU 上 26 分钟的录音 15 分钟都跑不完），整段一次跑完要一两分钟；
放在服务进程里就得一直占着 GPU 锁（MPS 不能在同一进程里多线程并用），这期间实时转写会卡住。不同进程可以同时用 MPS。

隐私：pyannote 默认会把用法统计（音频时长、人数、会话 id）发到 otel.pyannote.ai，这里在导入前强制关掉；
模型从 ModelScope 下载一次（约 31 MB，和 Hugging Face 上 pyannote-community 的文件逐字节相同），之后只从本地目录加载，不再联网。
"""
import json
import os
import sys
import time

os.environ["PYANNOTE_METRICS_ENABLED"] = "false"  # 必须在导入 pyannote.audio 之前
MODEL = "pyannote/speaker-diarization-community-1"


def model_dir() -> str:
    from modelscope import snapshot_download
    try:
        return snapshot_download(MODEL, local_files_only=True)
    except Exception:  # noqa: BLE001  还没下载过
        return snapshot_download(MODEL)


def diarize(wav: str, num_spk: int = 0) -> dict:
    import soundfile as sf
    import torch
    from pyannote.audio import Pipeline
    t = time.time()
    dev = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    pipe = Pipeline.from_pretrained(model_dir())
    pipe.to(torch.device(dev))
    t_load = time.time() - t
    x, sr = sf.read(wav, dtype="float32")
    if x.ndim > 1:
        x = x[:, 0]
    kw = {"num_speakers": int(num_spk)} if num_spk and num_spk > 0 else {}
    r = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": sr}, **kw)
    names: dict = {}
    turns = [[int(seg.start * 1000), int(seg.end * 1000), names.setdefault(spk, len(names))]
             for seg, _, spk in r.exclusive_speaker_diarization.itertracks(yield_label=True) if seg.end > seg.start]
    return {"turns": turns, "device": dev, "load_s": round(t_load, 1), "run_s": round(time.time() - t - t_load, 1)}


if __name__ == "__main__":
    res = diarize(sys.argv[1], int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    with open(sys.argv[2], "w") as f:
        json.dump(res, f)
