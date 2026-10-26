"""说话人聚类后处理的单元测试（asr_engine.cluster_speakers）。不加载语音模型，几秒跑完。

覆盖：HDBSCAN 噪声块分给最近的人、不到 30 秒的小簇被并掉、合并阈值生效、指定人数时仍走 FunASR 原来的路径。

用法：.venv/bin/python tests/test_diarize_cluster.py
"""
import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest import mock

import numpy as np
import torch

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import asr_engine  # noqa: E402
from funasr.models.campplus.cluster_backend import ClusterBackend  # noqa: E402

CB = ClusterBackend(merge_thr=0.78)


def speakers(n_spk, per, dim=32, noise=0.05, seed=0, cos=0.0):
    """造 n_spk 个说话人的声纹，每人 per[i] 块。cos>0 时所有中心向同一个方向靠，两两相似度约为 cos。"""
    r = np.random.default_rng(seed)
    Q = np.linalg.qr(r.normal(size=(dim, n_spk + 1)))[0]  # 两两正交的方向
    X, y = [], []
    for i in range(n_spk):
        c = np.sqrt(cos) * Q[:, 0] + np.sqrt(1 - cos) * Q[:, i + 1]
        X.append(c + noise * r.normal(size=(per[i], dim)))
        y += [i] * per[i]
    return np.concatenate(X).astype(np.float32), np.array(y)


def same_partition(a, b):
    return len(set(zip(a.tolist(), b.tolist()))) == len(set(a.tolist())) == len(set(b.tolist()))


def fake_umap_cb(labels):
    """让 ≥2048 块的分支直接返回给定的 HDBSCAN 结果（不真跑 UMAP），用来造噪声块和小簇。"""
    class H:
        def __init__(self, **kw):
            pass

        def fit_predict(self, u):
            return labels.copy()

    class U:
        def __init__(self, **kw):
            assert kw.get("random_state") == 0, "UMAP 必须固定种子"

        def fit_transform(self, X):
            return X

    import sklearn.cluster
    import umap.umap_
    return mock.patch.multiple(sklearn.cluster, HDBSCAN=H), mock.patch.multiple(umap.umap_, UMAP=U)


def run_umap(X, hdb_labels, **kw):
    p1, p2 = fake_umap_cb(hdb_labels)
    with p1, p2:
        return asr_engine.cluster_speakers(X, CB, **kw)


def test_noise_assigned():
    X, y = speakers(3, [800, 800, 800])
    hdb = y.copy()
    noisy = np.arange(0, len(y), 7)  # 每 7 块标一个噪声
    hdb[noisy] = -1
    lab = run_umap(X, hdb, min_sec=0, merge_thr=0.78)
    assert (lab >= 0).all(), "噪声块没被分掉"
    assert len(set(lab.tolist())) == 3
    assert same_partition(lab, y), "噪声块应该分给自己真正的说话人"


def test_tiny_cluster_absorbed():
    X, y = speakers(3, [1000, 1000, 100])
    hdb = y.copy()
    hdb[1990:2000] = 3  # 10 块 = 7.5 秒的碎簇，其实是 1 号说话人
    lab = run_umap(X, hdb, min_sec=30, merge_thr=0.99)
    assert len(set(lab.tolist())) == 3, "7.5 秒的碎簇应被并掉，75 秒的 2 号要保留"
    assert same_partition(lab, y)
    # 阈值调到 90 秒，75 秒的 2 号也会被拆掉
    lab = run_umap(X, hdb, min_sec=90, merge_thr=0.99)
    assert len(set(lab.tolist())) == 2
    # min_sec=0 不并（碎簇和 1 号声纹几乎一样，合并阈值设成 1 才不会被合并那一步并掉）
    assert len(set(run_umap(X, hdb, min_sec=0, merge_thr=1.0).tolist())) == 4


def test_merge_threshold():
    X, y = speakers(2, [1200, 1200], cos=0.75, noise=0.01)  # 两人中心余弦约 0.75
    assert len(set(run_umap(X, y, min_sec=0, merge_thr=0.78).tolist())) == 2
    assert len(set(run_umap(X, y, min_sec=0, merge_thr=0.72).tolist())) == 1
    assert len(set(run_umap(X, y, min_sec=0).tolist())) == 1, "默认阈值应是 0.72"
    assert asr_engine.SPK_MERGE_THR == 0.72 and asr_engine.SPK_MIN_SEC == 30


def test_spectral_and_tiny():
    X, y = speakers(3, [300, 300, 300])
    lab = asr_engine.cluster_speakers(X, CB)  # < 2048 块走谱聚类
    assert same_partition(lab, y)
    assert (asr_engine.cluster_speakers(X[:10], CB) == 0).all()


def test_umap_real_reproducible():
    X, y = speakers(3, [700, 700, 700])  # 2100 块，真跑 UMAP + HDBSCAN
    a = asr_engine.cluster_speakers(X, CB)
    b = asr_engine.cluster_speakers(X, CB)
    assert (a == b).all(), "固定种子后两次结果应一致"
    assert same_partition(a, y)


class RecCB(ClusterBackend):
    """记下 FunASR 聚类被怎么调用。"""
    def __init__(self):
        super().__init__(merge_thr=0.78)
        self.calls = []

    def forward(self, X, **params):
        self.calls.append(params.get("oracle_num"))
        return super().forward(X, **params)


class FakeFull:
    spk_model, spk_kwargs = None, {}

    def __init__(self, X):
        self.X, self.i = X, 0
        self.cb_model = RecCB()

    def inference(self, wavs, **kw):
        out = [{"spk_embedding": torch.from_numpy(self.X[self.i + j:self.i + j + 1])} for j in range(len(wavs))]
        self.i += len(wavs)
        return out


def test_oracle_num_spk_unchanged():
    x = np.zeros(asr_engine.SR * 120, dtype=np.float32)  # 每人约 60 秒，不会被当成小簇并掉
    segs = [[0, 120000]]
    n = len(asr_engine._sv_chunk([[0, 120, x]]))
    X, _ = speakers(2, [n // 2, n - n // 2])
    eng = asr_engine.Engine.__new__(asr_engine.Engine)
    eng.full_lock = threading.Lock()
    eng.last_info = {}
    eng.full = FakeFull(X)
    with mock.patch.object(asr_engine, "cluster_speakers", side_effect=AssertionError("指定人数时不该走新后处理")):
        eng._diarize(x, segs, num_spk=3)
    assert eng.full.cb_model.calls == [3], "指定人数时应照旧调用 FunASR 的 cb_model(oracle_num=k)"
    eng.full = FakeFull(X)
    with mock.patch.object(asr_engine, "cluster_speakers", wraps=asr_engine.cluster_speakers) as cs:
        turns = eng._diarize(x, segs, num_spk=0)
    assert cs.call_count == 1 and eng.full.cb_model.calls == []
    assert len({t[2] for t in turns}) == 2


if __name__ == "__main__":
    fails = 0
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            try:
                f()
                print("ok  ", k)
            except Exception as e:  # noqa: BLE001
                fails += 1
                print("FAIL", k, repr(e))
    sys.exit(1 if fails else 0)
