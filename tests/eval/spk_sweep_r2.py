"""第二轮人数判断的候选（docs/improvements.md 第二轮第 4 项），在 spk_embed_r2.py 的缓存上离线跑，写出 RTTM 和人数。

  .venv/bin/python tests/eval/spk_sweep_r2.py --cache ~/eval-out/spk-cache-r2 --out ~/eval-out/spk-sweep-r2 [--only 前缀...] [--cands 名字...]
"""
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-eval-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import asr_engine as A  # noqa: E402
from funasr.models.campplus import cluster_backend as cb  # noqa: E402

BACK = cb.ClusterBackend(merge_thr=0.78)
# 名字 → (安静块阈值 dB 或 None, 小簇秒数, 合并阈值)
CANDS = {"base": (None, 30, 0.72), "Q12": (12, 30, 0.72), "Q18": (18, 30, 0.72), "M60": (None, 60, 0.72), "T68": (None, 30, 0.68),
         "Q12M60": (12, 60, 0.72), "Q12T68": (12, 30, 0.68), "Q18M60": (18, 60, 0.72), "Q18T68": (18, 30, 0.68)}


def labels_for(X, rms, q, min_sec, thr):
    if q is None or len(rms) == 0:
        return A.cluster_speakers(X, BACK, min_sec=min_sec, merge_thr=thr)
    quiet = rms < np.median(rms) - q
    if (~quiet).sum() < 20 or not quiet.any():
        return A.cluster_speakers(X, BACK, min_sec=min_sec, merge_thr=thr)
    lab = np.full(len(X), -1, dtype=int)
    lab[~quiet] = A.cluster_speakers(X[~quiet], BACK, min_sec=min_sec, merge_thr=thr)
    A._assign_nearest(lab, X, np.where(quiet)[0], lab)  # 安静块不参与聚类，事后分给最近的人
    return lab


ap = argparse.ArgumentParser()
ap.add_argument("--cache", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--only", nargs="*", default=None)
ap.add_argument("--cands", nargs="*", default=list(CANDS))
o = ap.parse_args()
cache, out = Path(o.cache).expanduser(), Path(o.out).expanduser()
out.mkdir(parents=True, exist_ok=True)
cp = out / "counts.json"
counts = json.loads(cp.read_text()) if cp.exists() else {}
for f in sorted(p for p in cache.glob("*.npz") if not o.only or any(p.stem.startswith(x) for x in o.only)):
    z = np.load(f)
    t, X, segs, rms = z["t"], z["X"], z["segs"].tolist(), z["rms"]
    for name in o.cands:
        lab = labels_for(X, rms, *CANDS[name])
        turns = [(int(a * 1000), int(b * 1000), int(s)) for a, b, s in A._sv_postprocess([[a, b] for a, b in t], None, lab, X)]
        units = A.Engine._speaker_units(segs, turns)
        d = out / name
        d.mkdir(exist_ok=True)
        with open(d / f"{f.stem}.rttm", "w") as fh:
            for a, b, s in turns:
                if b > a:
                    fh.write(f"SPEAKER {f.stem} 1 {a / 1000:.3f} {(b - a) / 1000:.3f} <NA> <NA> spk{s} <NA> <NA>\n")
        counts.setdefault(name, {})[f.stem] = {"n": len({u[2] for u in units}), "chunks": int(len(X)),
                                               "quiet": int((rms < np.median(rms) - (CANDS[name][0] or 999)).sum()) if len(rms) else 0}
    print(f.stem, {k: counts[k][f.stem]["n"] for k in o.cands}, flush=True)
    cp.write_text(json.dumps(counts, ensure_ascii=False, indent=1))
