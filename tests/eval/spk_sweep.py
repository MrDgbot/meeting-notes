"""在缓存的声纹上试不同的聚类后处理，写出每个方案的 RTTM 和人数（docs/prereg-deviations.md D5）。

  .venv/bin/python tests/eval/spk_sweep.py --cache ~/eval-out/spk-cache --out ~/eval-out/spk-sweep [--only 文件名前缀...]

方案名：n{keep|assign}_m{小簇秒数}_t{合并阈值}_s{种子}。n keep / m 0 / t 0.78 就是产品现状（UMAP 加了种子）。
人数：照产品的做法，把聚类结果过一遍 Engine._speaker_units（短轮次并入相邻），数剩下的说话人。
"""
import argparse
import itertools
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-eval-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import asr_engine  # noqa: E402  导入时会打上产品对谱聚类的补丁（固定 k-means 种子）
from funasr.models.campplus import cluster_backend as cb  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--cache", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--only", nargs="*", default=None)
ap.add_argument("--seeds", type=int, nargs="*", default=[0])
o = ap.parse_args()
STEP = 0.75  # 小块步长（秒），sv_chunk 的默认值
BACK = cb.ClusterBackend(merge_thr=0.78)


def base_labels(X, seed):
    """和 ClusterBackend.forward 一样，只是 UMAP 加了种子；不做合并。返回 (labels, 用了哪种聚类)。"""
    if X.shape[0] < 20:
        return np.zeros(X.shape[0], dtype=int), "tiny"
    if X.shape[0] < 2048:
        return BACK.spectral_cluster(X, None), "spectral"
    import umap.umap_ as umap
    from sklearn.cluster import HDBSCAN
    u = umap.UMAP(n_neighbors=20, min_dist=0.0, n_components=min(60, X.shape[0] - 2), metric="cosine", random_state=seed).fit_transform(X)
    return HDBSCAN(min_samples=10, min_cluster_size=10, allow_single_cluster=True).fit_predict(u), "umap"


def unit(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def centroids(labels, X):
    ks = sorted(k for k in set(labels.tolist()) if k >= 0)
    return ks, (unit(np.stack([X[labels == k].mean(0) for k in ks])) if ks else None)


def post(labels, X, noise, min_sec, thr):
    labels = labels.copy()
    if noise == "assign" and (labels < 0).any() and (labels >= 0).any():
        ks, C = centroids(labels, X)
        idx = np.where(labels < 0)[0]
        labels[idx] = np.array(ks)[np.argmax(unit(X[idx]) @ C.T, axis=1)]
    while min_sec > 0:  # 小簇：最小的先拆，每块分给剩下的人里最近的那个
        ks = [k for k in set(labels.tolist()) if k >= 0]
        if len(ks) < 2:
            break
        small = min(ks, key=lambda k: (labels == k).sum())
        if (labels == small).sum() * STEP >= min_sec:
            break
        rest = np.where(labels != small, labels, -2)
        rk, C = centroids(np.where(rest >= 0, rest, -1), X)
        idx = np.where(labels == small)[0]
        labels[idx] = np.array(rk)[np.argmax(unit(X[idx]) @ C.T, axis=1)]
    # 合并相近说话人：用 FunASR 自己的实现（要求非噪声标签从 0 连续编号）
    m = labels >= 0
    if m.any():
        uniq = sorted(set(labels[m].tolist()))
        remap = {k: i for i, k in enumerate(uniq)}
        lab2 = labels.copy()
        lab2[m] = [remap[k] for k in labels[m]]
        lab2[m] = BACK.merge_by_cos(lab2[m], X[m], thr) if len(uniq) > 1 else lab2[m]
        labels = lab2
    return labels


cache = Path(o.cache).expanduser()
out = Path(o.out).expanduser()
files = sorted(p for p in cache.glob("*.npz") if not o.only or any(p.stem.startswith(x) for x in o.only))
grid = list(itertools.product(["keep", "assign"], [0, 15, 30, 60], [0.78, 0.72, 0.66]))
counts = json.loads((out / "counts.json").read_text()) if (out / "counts.json").exists() else {}
for f in files:
    z = np.load(f)
    t, X, segs = z["t"], z["X"], z["segs"].tolist()
    for seed in o.seeds:
        lab0, kind = base_labels(X, seed)
        for noise, min_sec, thr in grid:
            if seed != 0 and not (noise == "keep" and min_sec == 0 and thr == 0.78):
                continue  # 其余种子只跑现状，用来估计随机波动
            name = f"n{noise}_m{min_sec}_t{thr}_s{seed}"
            lab = post(lab0, X, noise, min_sec, thr)
            turns = [(int(a * 1000), int(b * 1000), int(s)) for a, b, s in asr_engine._sv_postprocess([[a, b] for a, b in t], None, lab, X)]
            units = asr_engine.Engine._speaker_units(segs, turns)
            d = out / name
            d.mkdir(parents=True, exist_ok=True)
            with open(d / f"{f.stem}.rttm", "w") as fh:
                for a, b, s in turns:
                    if b > a:
                        fh.write(f"SPEAKER {f.stem} 1 {a / 1000:.3f} {(b - a) / 1000:.3f} <NA> <NA> spk{s} <NA> <NA>\n")
            counts.setdefault(name, {})[f.stem] = {"n_units_spk": len({u[2] for u in units}), "n_clusters": len(set(lab.tolist())),
                                                   "noise_chunks": int((lab0 < 0).sum()), "chunks": int(len(X)), "kind": kind}
    print(f.stem, kind, len(X), "块，现状簇数", counts[f"nkeep_m0_t0.78_s0"][f.stem], flush=True)
(out / "counts.json").write_text(json.dumps(counts, ensure_ascii=False, indent=1))
