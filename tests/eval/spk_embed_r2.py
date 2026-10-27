"""第二轮（人数判断）用的声纹缓存：照产品现在的做法（音量归一 level_pair，VAD 用归一后的音频），
另外记下每个小块在原始录音里的音量（dBFS），供“小声的块不参与聚类”这类方案离线试。

  .venv/bin/python tests/eval/spk_embed_r2.py --out ~/eval-out/spk-cache-r2 <wav...>

每个文件一个 npz：t（每块开始、结束秒）、X（声纹）、segs（VAD 段，毫秒）、rms（每块原始音量 dBFS）、gain（整段放大了多少 dB）。已有的跳过。
"""
import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

ap = argparse.ArgumentParser()
ap.add_argument("wavs", nargs="+")
ap.add_argument("--out", required=True)
o = ap.parse_args()
tmp = Path(tempfile.mkdtemp(prefix="mn-eval-"))
(tmp / "meetings").mkdir()
(tmp / "settings.json").write_text(json.dumps({"asr": {"model": "nano"}}))
os.environ["MEETING_DATA"] = str(tmp)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import asr_engine  # noqa: E402

out = Path(o.out).expanduser()
out.mkdir(parents=True, exist_ok=True)
eng = asr_engine.Engine()
eng.load()
if not eng.ready:
    sys.exit(f"模型加载失败：{eng.error}")
SR = asr_engine.SR
for w in map(Path, o.wavs):
    dst = out / f"{w.stem}.npz"
    if dst.exists():
        continue
    t0 = time.time()
    x0, sr = sf.read(str(w), dtype="float32")
    if x0.ndim > 1:
        x0 = x0[:, 0]
    assert sr == SR, sr
    x, xv = asr_engine.level_pair(x0)
    segs = eng._offline_segs(xv, None)
    chunks, X = eng._spk_embeddings(x, segs)
    t = np.array([[c[0], c[1]] for c in chunks])
    rms = np.array([20 * np.log10(np.sqrt(np.mean(x0[int(a * SR):int(b * SR)] ** 2)) + 1e-9) for a, b in t]) if len(t) else np.zeros(0)
    gain = 20 * np.log10((np.abs(x).max() + 1e-9) / (np.abs(x0).max() + 1e-9))
    np.savez(dst, t=t, X=X, segs=np.array(segs), rms=rms, gain=gain)
    print(f"{w.stem}: {len(x0) / SR / 60:.1f} 分钟，{len(segs)} 段，{len(chunks)} 块，放大 {gain:.1f} dB，{time.time() - t0:.0f}s", flush=True)
