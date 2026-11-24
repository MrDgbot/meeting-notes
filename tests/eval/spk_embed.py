"""用产品自己的切分和声纹代码，把每个录音的 1.5 秒小块声纹存下来，供 spk_sweep.py 反复试聚类，不用每次重跑模型。

  .venv/bin/python tests/eval/spk_embed.py --out ~/eval-out/spk-cache ~/eval-data/ali-eval/wav/*.wav ~/eval-data/weekly-1023/audio16k.wav

每个文件存一个 npz：t（每块的开始、结束秒）、X（声纹）、segs（VAD 段，毫秒）。已有结果的文件跳过。
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
(tmp / "settings.json").write_text(json.dumps({"asr": {"model": "doubao"}}))
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
    name = "weekly-1023" if w.parent.name == "weekly-1023" else w.stem
    dst = out / f"{name}.npz"
    if dst.exists():
        continue
    t0 = time.time()
    x, sr = sf.read(str(w), dtype="float32")
    if x.ndim > 1:
        x = x[:, 0]
    assert sr == SR, sr
    segs = eng._offline_segs(x, None)
    chunks = asr_engine._sv_chunk([[s / 1000, e / 1000, x[int(s * SR / 1000):int(e * SR / 1000)]] for s, e in segs])
    embs = []
    for i in range(0, len(chunks), 128):
        res = eng.full.inference([c[2] for c in chunks[i:i + 128]], input_len=None, model=eng.full.spk_model, kwargs=eng.full.spk_kwargs)
        embs.append(torch.cat([r["spk_embedding"] for r in res]).cpu())
    X = torch.cat(embs).numpy()
    np.savez(dst, t=np.array([[c[0], c[1]] for c in chunks]), X=X, segs=np.array(segs))
    print(f"{name}: {len(x) / SR / 60:.1f} 分钟，{len(segs)} 段，{len(chunks)} 块，{time.time() - t0:.0f}s", flush=True)
