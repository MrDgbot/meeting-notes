"""短录音的人数（docs/improvements.md 第二轮“短录音的人数”）：从长录音里随机取 1/2/4 分钟窗口，只用窗口内的声纹小块重新聚类，比几种小簇门槛。

  .venv/bin/python tests/eval/spk_short_r2.py --cache ~/eval-out/spk-cache-r2 --sets ali-eval a4-trainL [--cands base R10 R20]
参考人数 = 窗口里说话够 3 秒的人（RTTM）。人数照产品：聚类 → _sv_postprocess → _speaker_units 后剩下的说话人。
"""
import argparse
import os
import random
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

import numpy as np

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-eval-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import asr_engine as A  # noqa: E402
from funasr.models.campplus import cluster_backend as cb  # noqa: E402

H = Path.home()
SETS = {"ali-eval": H / "eval-data/ali-eval/ref", "a4-trainL": H / "eval-data/aishell4/train_L/ref", "a4-test": H / "eval-data/aishell4/test/ref"}
BACK = cb.ClusterBackend(merge_thr=0.78)
CANDS = {"base": None, "R10": 0.10, "R20": 0.20}


def ref_turns(p):
    out = []
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            out.append((float(f[3]), float(f[3]) + float(f[4]), f[7]))
    return out


def count_window(t, X, segs, w0, w1, frac):
    m = (t[:, 0] >= w0) & (t[:, 1] <= w1)
    if m.sum() == 0:
        return 0
    Xs, ts = X[m], t[m]
    speech = sum(min(e, w1 * 1000) - max(s, w0 * 1000) for s, e in segs if min(e, w1 * 1000) > max(s, w0 * 1000)) / 1000
    ms = A.SPK_MIN_SEC if frac is None else min(A.SPK_MIN_SEC, frac * speech)
    lab = A.cluster_speakers(Xs, BACK, min_sec=ms)
    turns = [(int(a * 1000), int(b * 1000), int(s)) for a, b, s in A._sv_postprocess([[a, b] for a, b in ts], None, lab, Xs)]
    sg = [[max(s, int(w0 * 1000)), min(e, int(w1 * 1000))] for s, e in segs if min(e, w1 * 1000) > max(s, w0 * 1000)]
    return len({u[2] for u in A.Engine._speaker_units(sg, turns)}) if turns else 0


ap = argparse.ArgumentParser()
ap.add_argument("--cache", required=True)
ap.add_argument("--sets", nargs="+", required=True)
ap.add_argument("--cands", nargs="*", default=list(CANDS))
ap.add_argument("--lens", type=float, nargs="*", default=[1, 2, 4])
ap.add_argument("--per", type=int, default=3)
o = ap.parse_args()
cache = Path(o.cache).expanduser()
for s in o.sets:
    rng = random.Random(0)
    stat = defaultdict(lambda: [0, 0, 0])  # (cand, len) -> 判对, 误差和, 个数
    for rp in sorted(SETS[s].glob("*.rttm")):
        npz = cache / f"{rp.stem}.npz"
        if not npz.exists():
            continue
        z = np.load(npz)
        t, X, segs = z["t"], z["X"], z["segs"].tolist()
        R = ref_turns(rp)
        dur = t[-1, 1]
        for L in o.lens:
            for _ in range(o.per):
                w0 = rng.uniform(0, max(0.0, dur - L * 60)); w1 = w0 + L * 60
                per = defaultdict(float)
                for a, b, k in R:
                    if min(b, w1) > max(a, w0):
                        per[k] += min(b, w1) - max(a, w0)
                true_n = sum(v >= 3 for v in per.values())
                for c in o.cands:
                    n = count_window(t, X, segs, w0, w1, CANDS[c])
                    st = stat[(c, L)]
                    st[0] += n == true_n; st[1] += abs(n - true_n); st[2] += 1
    print(f"== {s}")
    for c in o.cands:
        cells = [f"{L:g} 分钟 {stat[(c, L)][0]}/{stat[(c, L)][2]} 误差 {stat[(c, L)][1] / stat[(c, L)][2]:.2f}" for L in o.lens]
        tot = [sum(stat[(c, L)][i] for L in o.lens) for i in range(3)]
        print(f"  {c:5} " + " | ".join(cells) + f" | 合计 {tot[0]}/{tot[2]} 误差 {tot[1] / tot[2]:.3f}")
