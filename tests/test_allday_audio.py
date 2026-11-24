"""全天记录写进文件的音频：不重复、句间停顿是真实音频、长静音记成跳点。不采音、不加载模型。

用法：.venv/bin/python tests/test_allday_audio.py
"""
import os
import queue
import sys
import tempfile
import threading
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-allday-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

import ambient
import store
import waveform
from asr_engine import SR

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


def fake_ambient():
    a = object.__new__(ambient.Ambient)
    a.lock = threading.RLock()
    a.conv = None
    a.cfg = {**ambient.DEFAULTS}
    a._cap = 1
    a.q = queue.Queue()
    a._pending_close = set()
    a._plock = threading.Lock()
    a._done_seq = 0
    a.partial = None
    return a


def test_plan_write():
    k = 3 * SR
    check(ambient.plan_write(True, 1000, 800, 5000, 0, k) == (1000, 5000, 0), "重叠：从上一句写到的地方接着写，不重复")
    check(ambient.plan_write(True, 1000, 2000, 5000, 0, k) == (1000, 5000, 0), "短停顿：连真实音频一起写")
    check(ambient.plan_write(True, 1000, 1000 + k + 1, 1000 + k + 900, 0, k)[2] == k + 1, "长静音：跳过并报告长度")
    check(ambient.plan_write(True, 1000, 2000, 5000, 1500, k)[2] == 1000, "缓冲里已经没有间隔的音频：只能跳，但要报告")
    check(ambient.plan_write(False, 1000, 2000, 5000, 0, k) == (2000, 5000, -1), "换了采集进程：跳，长度按墙钟算")
    check(ambient.plan_write(True, 6000, 2000, 5000, 0, k) == (6000, 6000, 0), "整句都已写过：不再写")


def test_join_clips():
    a, b = np.ones(10, np.float32), np.arange(10, dtype=np.float32)
    check(len(ambient.join_clips(a, b, 0)) == 20, "紧挨着直接拼")
    m = ambient.join_clips(a, b, -1)  # 重叠 1ms（16 个样本）
    check(len(m) < 20, "重叠时去掉重复部分")
    check(len(ambient.join_clips(a, b, 1000)) == 20 + SR, "有间隔补静音")


def test_segment_writes_contiguous():
    a = fake_ambient()
    t0 = 1_000_000.0
    total = SR * 20
    sig = (np.arange(total) % 30000 / 30000.0).astype(np.float32) * 0.5  # 每个样本都不一样，能看出重复/缺失

    def wall_of(ms):
        return t0 + ms / 1000

    # 1) 0.5~4s 说话 2) 4.2~8s（间隔 0.2s，以前会重复 0.3s 音频）3) 9.5~10s（间隔 1.5s，补真实音频）
    # 4) 16~18s（间隔 6s，超过 GAP_KEEP：跳点）
    for beg, end in ((500, 4000), (4200, 8000), (9500, 10000), (16000, 18000)):
        a._segment(sig, 0, beg, end, wall_of, 1)
    c = a.conv
    try:
        c.f.close()
        pcm = np.fromfile(store.mdir(c.mid) / "audio.pcm", np.int16).astype(np.float32) / 32767
        pad = ambient.PAD_MS * SR // 1000
        first = 500 * SR // 1000 - pad
        cont = sig[first:10000 * SR // 1000 + pad]
        n = len(cont)
        check(np.allclose(pcm[:n], cont, atol=2e-4), "前三句和中间停顿是一段连续的原始音频，没有重复、没有数字静音")
        tail = sig[16000 * SR // 1000 - pad:18000 * SR // 1000 + pad]
        check(len(pcm) == n + len(tail), f"文件长度 = 连续段 + 跳点后的一句（{len(pcm)} vs {n + len(tail)}）")
        sk = store.load(c.mid, "skips.json")
        check(len(sk) == 1, "长静音记了一个跳点")
        if sk:
            s0 = sk[0]
            check(abs(s0["pos_ms"] - n * 1000 // SR) <= 1, "跳点位置在连续段末尾")
            check(abs(s0["skipped_s"] - 5.5) < 0.05, f"跳过的真实时长 5.5 秒（{s0['skipped_s']}）")
        # 识别队列里每句的起点要对上文件里的位置
        items = []
        while not a.q.empty():
            items.append(a.q.get())
        starts = [it[3] for it in items if it[0] == "seg"]
        check(starts[0] == 0 and abs(starts[1] - (4200 - 500)) <= 1, f"第二句起点按真实间隔算（{starts[:2]}）")
    finally:
        if not c.f.closed:
            c.f.close()
        store.delete(c.mid)


def test_skips_from_segmap():
    sm = [[0, 100.0], [5000, 105.0], [6000, 200.0]]
    sk = ambient.skips_from_segmap(sm)
    check(len(sk) == 1 and sk[0]["pos_ms"] == 6000 and abs(sk[0]["skipped_s"] - 94) < 0.1, "老录音从分段映射推出跳点")


def test_waveform():
    check(waveform.bucket_s(60) == 0.25 and waveform.bucket_s(7200) == 3.0, "波形分桶")
    lv = waveform.levels(np.r_[np.zeros(100), np.ones(100) * 0.5].astype(np.float32), 100)
    check(lv[0] == 0 and 0.8 < lv[1] < 1, "静音为 0，有声音接近 1")


def simulate(a, sig, segs, t0=2_000_000.0):
    """按采集循环的方式跑一遍：每 300ms 一块，开口约 0.6 秒后才知道、说完 1.2 秒后才断句，
    环形缓冲按 ring_keep_from 裁剪（以前的测试直接给整段音频，测不出说话时缓冲被裁掉的问题）。"""
    chunk = ambient.CHUNK_MS * ambient.SR // 1000
    ring, ring_base, fed, seg_start = np.zeros(0, np.float32), 0, 0, None
    todo = list(segs)
    while fed < len(sig):
        x = sig[fed:fed + chunk]
        fed += len(x)
        ring = np.concatenate([ring, x])
        now_ms = fed * 1000 // SR
        if todo:
            beg, end = todo[0]
            if seg_start is None and now_ms >= beg + 600:
                seg_start = beg
            if seg_start is not None and now_ms >= end + ambient.END_SILENCE_MS:
                a._segment(ring, ring_base, beg, end, lambda ms: t0 + ms / 1000, 1)
                seg_start = None
                todo.pop(0)
        keep = ambient.ring_keep_from(seg_start, fed, ambient.gap_keep_ms(a.cfg))
        cut = min(keep - ring_base, len(ring))
        if cut > 0:
            ring, ring_base = ring[cut:], ring_base + cut
    c = a.conv
    c.f.close()
    pcm = np.fromfile(store.mdir(c.mid) / "audio.pcm", np.int16).astype(np.float32) / 32767
    return c, pcm, store.load(c.mid, "skips.json")


def make_sig(sec):
    return (np.arange(SR * sec) % 30000 / 30000.0).astype(np.float32) * 0.5


def test_ring_keeps_short_pauses():
    a = fake_ambient()
    sig = make_sig(40)
    # 停顿 0.4s / 1.5s / 2.8s 都应连着写；10s 的停顿记一个跳点
    segs = [(1000, 4000), (4400, 7000), (8500, 11000), (13800, 16000), (26000, 28000)]
    c, pcm, sk = simulate(a, sig, segs)
    try:
        pad = ambient.PAD_MS * SR // 1000
        cont = sig[1000 * SR // 1000 - pad:16000 * SR // 1000 + pad]
        check(np.allclose(pcm[:len(cont)], cont, atol=2e-4), "说话跨多块时，短停顿也是连续的原始音频（以前会被记成跳点）")
        check(len(sk) == 1 and abs(sk[0]["skipped_s"] - 9.5) < 0.1, f"只有 10 秒那次停顿记成跳点（{sk}）")
    finally:
        store.delete(c.mid)


def test_keep_silence_continuous():
    a = fake_ambient()
    a.cfg["keep_silence"] = True
    check(ambient.gap_keep_ms(a.cfg) == 5 * 60000, "不跳过静音：到「静音多久算对话结束」为止都写")
    check(ambient.gap_keep_ms({"keep_silence": True, "split_min": 90}) == ambient.KEEP_SILENCE_MAX_MIN * 60000, "缓冲有上限")
    check(ambient.gap_keep_ms({}) == ambient.GAP_KEEP_MS, "默认仍跳过 3 秒以上的静音")
    sig = make_sig(60)
    segs = [(1000, 4000), (14000, 16000), (45000, 47000)]
    c, pcm, sk = simulate(a, sig, segs)
    try:
        pad = ambient.PAD_MS * SR // 1000
        cont = sig[1000 * SR // 1000 - pad:47000 * SR // 1000 + pad]
        check(len(pcm) == len(cont) and np.allclose(pcm, cont, atol=2e-4), "10 秒、29 秒的停顿都原样录下，文件就是连续的原始音频")
        check(sk == [], "不记跳点")
    finally:
        store.delete(c.mid)


def test_ring_keep_from():
    g = ambient.GAP_KEEP_MS
    check(ambient.ring_keep_from(None, SR * 100, g) == SR * 100 - SR * ambient.RING_IDLE_MS // 1000, "没人说话：和以前一样留最近 6 秒")
    k = ambient.ring_keep_from(50_000, SR * 60, g)
    check(k <= (50_000 - ambient.PAD_MS - g) * SR // 1000, "说话时：这句开头之前还留着够补停顿的音频")


def test_cfg_roundtrip():
    prev = ambient.get_cfg()
    try:
        ambient.save_cfg({**ambient.DEFAULTS, "keep_silence": True})
        check(ambient.get_cfg()["keep_silence"] is True, "「不跳过静音」能保存")
        ambient.save_cfg({**ambient.DEFAULTS})
        check(ambient.get_cfg()["keep_silence"] is False, "默认关")
    finally:
        ambient.save_cfg(prev)


def test_storage_estimate():
    now = 1_800_000_000.0
    from datetime import datetime as dt
    iso = lambda t: dt.fromtimestamp(t).isoformat(timespec="seconds")
    ms = [{"source": "ambient", "created": iso(now - 3600), "started_at": iso(now - 3600), "ended_at": iso(now - 1800), "duration": 900},
          {"source": "ambient", "created": iso(now - 86400 * 30), "started_at": iso(now - 86400 * 30), "ended_at": iso(now - 86400 * 30 + 60), "duration": 60},
          {"source": "upload", "created": iso(now - 100), "duration": 999}]
    e = ambient.storage_estimate(ms, now=now)
    check(e["mb_per_hour"] == 28.8, f"64kbps = 28.8MB/小时（{e['mb_per_hour']}）")
    check(e["days"] == 1 and e["skip_h_day"] == 0.25 and e["cont_h_day"] == 0.5, f"只算最近两周的全天记录：录音 15 分钟、墙钟 30 分钟（{e}）")
    check(e["cont_mb_day"] == round(0.5 * 28.8), "不跳过 = 墙钟时长 × 码率")


def test_quiet_ranges():
    f = waveform.FRAME_S
    db = [-60.0] * 40 + [-20.0] * 40 + [-60.0] * 8 + [-20.0] * 40 + [-140.0] * 20 + [-20.0] * 10
    q = waveform.quiet_ranges(db)
    check(len(q) == 2, f"5 秒安静、2.5 秒数字静音算静音段，1 秒的停顿不算（{q}）")
    if q:
        check(abs(q[0][0] - waveform.QUIET_EDGE_S) < 1e-6 and abs(q[0][1] - (40 * f - waveform.QUIET_EDGE_S)) < 1e-6, "两头各让出一点，开口前后不加速")
    check(waveform.quiet_ranges([-30.0] * 100) == [], "一直一样响：不处理")
    x = np.r_[np.zeros(SR), np.ones(SR) * 0.3].astype(np.float32)
    check(len(waveform.frame_db(x, 500)) == 2 * SR // 500, "细粒度帧")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("FAILED" if fails else "ALL OK", fails)
    sys.exit(1 if fails else 0)
