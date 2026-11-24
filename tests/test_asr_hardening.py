"""ASR / 说话人分离 / 全天模式 / 双路录音 / 豆包 / 词库与热词加固单元测试（离线、不加载大模型）。

覆盖所有 P0/P1/P2 修复项：
- make_mp3 / pcm_to_wav / to_wav16k 原子写 + 退出码与非空校验；
- _diarize_pyannote / _diarize_nemotron 关闭 mkstemp FD 防泄漏；
- LiveSession 续录截齐残字节、feed 缓存非整帧残字节、VAD 异常不漏 FD、单双声道复用 _LiveChan；
- Engine._nano 括号提示泄露在清洗前拦截、_assign_speakers/_split_sentence 嵌套重叠段不丢主说话人；
- _unit 零向量防 NaN、_offline_segs 按 vad_kw 缓存 VAD、_speaker_units 嵌套重叠段不抢占外层说话人；
- Ambient._close_conv 原子性、锁保护共享集合、_RingBuffer 分块零拷贝、_awake/_kill_proc 回收僵尸进程、purge_old_audio 清 peaks.json、_live_cache 减少读盘；
- context_hotwords 早退、LRU 缓存、优先级不被低优长串挤掉、单遍替换；
- vocab._tools 线程安全、apply_paras 单次 _load、suspects 预计算读音；
- doubao_asr._Transcript 保留尾部未定稿句、_reset_device 校验 expected_did；
- dual_audio.drop_bleed 丢弃 i 后立即 break。

用法：.venv/bin/python tests/test_asr_hardening.py
"""
import asyncio
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-asr-hard-"))
sys.path.insert(0, str(ROOT))

import ambient  # noqa: E402
import asr_engine  # noqa: E402
import context_hotwords  # noqa: E402
import doubao_asr  # noqa: E402
import dual_audio  # noqa: E402
import store  # noqa: E402
import vocab  # noqa: E402


# ---------- P0 #1: make_mp3 / pcm_to_wav / to_wav16k 原子写与退出码检查 ----------
def test_atomic_ffmpeg_helpers_reject_errors_and_empty_outputs():
    d = Path(tempfile.mkdtemp(prefix="mn-ff-"))
    src = d / "in.wav"
    src.write_bytes(b"fake-wav")
    mp3 = d / "audio.mp3"
    mp3.write_bytes(b"existing-good-mp3")

    # 1) 非零退出码：抛 RuntimeError，不覆写已有文件，不遗留临时文件
    fail = subprocess.CompletedProcess(["ffmpeg"], 1, stdout="", stderr="disk full")
    with mock.patch.object(subprocess, "run", return_value=fail):
        try:
            asr_engine.make_mp3(src, mp3)
            assert False, "make_mp3 非零退出码应抛 RuntimeError"
        except RuntimeError as e:
            assert "MP3 编码失败" in str(e) and "disk full" in str(e)
    assert mp3.read_bytes() == b"existing-good-mp3", "失败不应破坏已有 mp3"
    assert not list(d.glob(".tmp-*")), f"失败后不应残留临时文件：{list(d.iterdir())}"

    # 2) 返回 0 但产物为空（0 字节）：同样拒绝并保留旧文件
    ok = subprocess.CompletedProcess(["ffmpeg"], 0, stdout="", stderr="")
    with mock.patch.object(subprocess, "run", return_value=ok):
        try:
            asr_engine.make_mp3(src, mp3)
            assert False, "0 字节 mp3 应抛 RuntimeError"
        except RuntimeError:
            pass
    assert mp3.read_bytes() == b"existing-good-mp3"
    assert not list(d.glob(".tmp-*"))

    # 3) 成功写临时文件后原子替换
    def fake_ok(cmd, **kw):
        Path(cmd[-1]).write_bytes(b"new-mp3-bytes")
        return ok

    with mock.patch.object(subprocess, "run", side_effect=fake_ok):
        asr_engine.make_mp3(src, mp3)
    assert mp3.read_bytes() == b"new-mp3-bytes"
    assert not list(d.glob(".tmp-*"))

    # 4) pcm_to_wav 与 to_wav16k 同样校验退出码且不破坏目标文件
    wav = d / "out.wav"
    wav.write_bytes(b"old-wav")
    with mock.patch.object(subprocess, "run", return_value=fail):
        for fn, args in ((asr_engine.pcm_to_wav, (src, wav, 1)), (asr_engine.to_wav16k, (src, wav))):
            try:
                fn(*args)
                assert False
            except RuntimeError:
                pass
    assert wav.read_bytes() == b"old-wav"
    assert not list(d.glob(".tmp-*"))

    # 5) 机器上有真 ffmpeg 时验证真实编码能通过
    if shutil.which("ffmpeg"):
        pcm = d / "real.pcm"
        pcm.write_bytes(np.zeros(16000, dtype="<i2").tobytes())
        real_wav = d / "real.wav"
        real_mp3 = d / "real.mp3"
        asr_engine.pcm_to_wav(pcm, real_wav, 1)
        assert real_wav.exists() and real_wav.stat().st_size > 44
        asr_engine.make_mp3(real_wav, real_mp3)
        assert real_mp3.exists() and real_mp3.stat().st_size > 100
        real_wav2 = d / "real2.wav"
        asr_engine.to_wav16k(real_mp3, real_wav2)
        assert real_wav2.exists() and real_wav2.stat().st_size > 44


# ---------- P0 #8: _diarize_pyannote / _diarize_nemotron 关闭 mkstemp FD ----------
def test_diarize_subprocesses_close_mkstemp_fd():
    eng = asr_engine.Engine.__new__(asr_engine.Engine)
    d = Path(tempfile.mkdtemp(prefix="mn-fd-"))
    wav = d / "a.wav"
    wav.write_bytes(b"RIFF")

    for method in (eng._diarize_pyannote, eng._diarize_nemotron):
        opened_fds = []
        closed_fds = []
        real_mkstemp = tempfile.mkstemp
        real_close = os.close

        def track_mkstemp(*a, **k):
            fd, name = real_mkstemp(*a, **k)
            opened_fds.append((fd, name))
            return fd, name

        def track_close(fd):
            closed_fds.append(fd)
            return real_close(fd)

        def fake_run(cmd, **k):
            # 子进程启动时，父进程必须已经关掉 mkstemp 返回的 fd
            assert opened_fds and opened_fds[-1][0] in closed_fds, "mkstemp fd 未在启动子进程前关闭"
            Path(cmd[3]).write_text(json.dumps({"turns": [[0, 1000, 0]], "device": "cpu", "load_s": 0.1, "run_s": 0.1}))
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch.object(tempfile, "mkstemp", side_effect=track_mkstemp), \
             mock.patch.object(os, "close", side_effect=track_close), \
             mock.patch.object(asr_engine, "duration_of", return_value=1.0), \
             mock.patch.object(subprocess, "run", side_effect=fake_run):
            turns = method(wav, 0)
        assert turns == [(0, 1000, 0)]
        assert not Path(opened_fds[-1][1]).exists(), "临时结果文件未清理"


# ---------- P1 #6a & P2 #4: LiveSession 对齐、不漏 FD、单双声道复用 _LiveChan ----------
class _StubVad:
    def __init__(self, emit=None):
        self.emit = emit or []
        self.calls = 0

    def generate(self, input, cache, is_final, chunk_size):
        self.calls += 1
        if is_final and self.emit:
            return [{"value": list(self.emit)}]
        return [{"value": []}]


class _StubEngine:
    def __init__(self, vad_exc=None, asr_text="测试文本"):
        self.vad_exc = vad_exc
        self.asr_text = asr_text
        self.vad_count = 0

    def new_vad(self):
        self.vad_count += 1
        if self.vad_exc is not None:
            raise self.vad_exc
        return _StubVad(emit=[[0, 200]])

    def asr_segment(self, audio, hotword="", punc=True, context=""):
        return self.asr_text


def test_live_session_alignment_and_no_fd_leak():
    d = Path(tempfile.mkdtemp(prefix="mn-live-align-"))

    # 1) new_vad 抛异常时不创建/不泄漏文件句柄
    bad_pcm = d / "bad.pcm"
    try:
        asr_engine.LiveSession(_StubEngine(vad_exc=RuntimeError("vad boom")), bad_pcm, "", channels=1)
        assert False
    except RuntimeError:
        pass
    assert not bad_pcm.exists(), "VAD 初始化失败时不应提前打开/创建 pcm"

    # 2) 单声道：已有 1 字节残尾先截齐；feed 奇数字节跨次拼齐，不崩 np.frombuffer
    mono_pcm = d / "mono.pcm"
    mono_pcm.write_bytes(b"\x10\x00\x20\x00\xff")  # 5 字节：应截齐到 4 字节（2 采样）
    sess = asr_engine.LiveSession(_StubEngine(), mono_pcm, "", channels=1)
    assert sess.offset == 2 and mono_pcm.stat().st_size == 4 and len(sess._chans) == 1
    assert sess.feed(b"\x01") == []  # 不足 1 帧，暂存不写盘
    assert sess.written == 0 and sess.file_bytes == 4
    sess.feed(b"\x02\x03\x04\x05")  # 1 + 4 = 5 -> 写 4 字节，余 1 字节
    assert sess.written == 4 and sess.file_bytes == 8 and mono_pcm.stat().st_size == 8
    sess.feed(b"\x06")  # 1 + 1 = 2 -> 写 2 字节
    assert sess.written == 6 and sess.file_bytes == 10
    events = sess.finish()
    assert mono_pcm.read_bytes() == b"\x10\x00\x20\x00\x01\x02\x03\x04\x05\x06"
    assert events and all("ch" not in e and "spk" not in e for e in events), f"单声道事件不应带 ch/spk：{events}"

    # 3) 双声道：4 字节一帧，3 字节残尾截齐，跨 feed 1+3 拼齐，事件带 ch/spk
    st_pcm = d / "stereo.pcm"
    st_pcm.write_bytes(b"\x00\x01\x02\x03\xaa\xbb\xcc")  # 7 字节 -> 截齐到 4 字节（1 帧）
    s2 = asr_engine.LiveSession(_StubEngine(), st_pcm, "", channels=2)
    assert s2.offset == 1 and st_pcm.stat().st_size == 4 and len(s2._chans) == 2
    s2.feed(b"\x11\x22\x33")
    assert s2.written == 0 and s2.file_bytes == 4
    s2.feed(b"\x44\x55")  # 3 + 2 = 5 -> 写 4 字节，余 1 字节
    assert s2.written == 4 and s2.file_bytes == 8 and st_pcm.stat().st_size == 8
    ev2 = s2.finish()
    assert st_pcm.read_bytes() == b"\x00\x01\x02\x03\x11\x22\x33\x44"
    assert ev2 and all("ch" in e and "spk" in e for e in ev2), f"双声道事件应带 ch/spk：{ev2}"


# ---------- P1 #6b: _nano 括号提示泄露在清洗前触发重解码 ----------
def test_nano_prompt_leak_triggers_redecode():
    eng = asr_engine.Engine.__new__(asr_engine.Engine)
    eng.nano_lock = threading.RLock()
    calls = []

    class FakeNano:
        model = None

        def generate(self, input, language="中文", itn=True, **kw):
            calls.append(kw.get("hotwords"))
            if kw.get("hotwords"):
                # 含括号泄露且其中刚好出现真实说过的热词：旧代码先删括号导致 PROMPT_LEAK_RE 失效
                return [{"text": "热词列表：[长尾词]今天看长尾词", "ctc_text": "今天看长尾词", "timestamps": []}]
            return [{"text": "今天看长尾词", "ctc_text": "今天看长尾词", "timestamps": []}]

    eng.nano = FakeNano()
    out = eng._nano(np.zeros(16000, dtype=np.float32), hotword="长尾词")
    assert len(calls) == 2 and calls[0] == ["长尾词"] and calls[1] is None, f"应触发去热词重解码：{calls}"
    assert out["text"] == "今天看长尾词", out


# ---------- P1 #6c: 嵌套重叠段在 _assign_speakers / _split_sentence 中不误丢主说话人 ----------
def test_nested_turns_preserve_primary_speaker():
    turns = [(0, 10000, 0), (1000, 2000, 1), (10000, 12000, 2)]
    sent = [{
        "start": 3000,
        "end": 12000,
        "text": "甲乙丙丁戊己庚辛壬癸",
        "ct": [(3000 + i * 900, 3800 + i * 900) for i in range(10)],
    }]
    out = asr_engine.Engine._assign_speakers([dict(sent[0])], turns, min_ms=1000)
    assert [x["spk"] for x in out] == [0, 2], f"应保留 0 号说话人并切到 2 号，实际：{out}"
    assert "".join(x["text"] for x in out) == "甲乙丙丁戊己庚辛壬癸"

    # 直接调用 _split_sentence 传入未过滤的嵌套段同样正确
    out2 = asr_engine.Engine._split_sentence([dict(sent[0])], turns, min_ms=1000)
    assert [x["spk"] for x in out2] == [0, 2], out2


# ---------- P1 #6d & #6e & P2 #4: _unit / _offline_segs 缓存 / _speaker_units / fallback / stereo ----------
def test_unit_zero_norm_and_offline_vad_cache_and_speaker_units():
    # _unit 零向量不产生 NaN
    u = asr_engine._unit(np.zeros((2, 4), dtype=np.float32))
    assert np.isfinite(u).all() and (u == 0).all()

    # _offline_segs 按 vad_kw 缓存，避免每次重新构建 AutoModel
    asr_engine._OFFLINE_VADS.clear()
    created = []

    class FakeAutoVad:
        def __init__(self, **kw):
            created.append(kw)

        def generate(self, input):
            return [{"value": [[0, 1000]]}]

    with mock.patch.object(asr_engine, "AutoModel", side_effect=FakeAutoVad):
        assert asr_engine.Engine._offline_segs(np.zeros(1600, np.float32), None) == [[0, 1000]]
        assert asr_engine.Engine._offline_segs(np.zeros(1600, np.float32), None) == [[0, 1000]]
        assert len(created) == 1, f"相同 vad_kw 应复用缓存：{len(created)}"
        assert asr_engine.Engine._offline_segs(np.zeros(1600, np.float32), {"speech_noise_thres": 0.4}) == [[0, 1000]]
        assert len(created) == 2
    asr_engine._OFFLINE_VADS.clear()

    # _speaker_units 嵌套重叠段不抢占外层说话人、不产零长度段
    units = asr_engine.Engine._speaker_units([[0, 10000]], [(0, 10000, 0), (2000, 3000, 1)])
    assert all(e > s for s, e, _ in units)
    assert units[-1][2] == 0 and units[-1][1] == 10000, f"短插话后应回归 0 号说话人：{units}"
    units2 = asr_engine.Engine._speaker_units([[0, 10000]], [(0, 10000, 0), (0, 1000, 1)])
    assert units2 == [[0, 10000, 0]], f"同起点短插话不应抢占整段或产零长片：{units2}"


def test_transcribe_fallback_and_stereo_last_info():
    eng = asr_engine.Engine()

    class FakeFull:
        def generate(self, input, **kw):
            return [{"sentence_info": [{"spk": 0, "start": 0, "end": 1000, "text": "你好"}]}]

    eng.full = FakeFull()
    eng.repunc = lambda t: t
    d = Path(tempfile.mkdtemp(prefix="mn-fb-"))
    wav = d / "m.wav"
    import soundfile as sf
    sf.write(wav, np.zeros(16000, dtype=np.float32), 16000)

    with mock.patch.object(asr_engine, "asr_mode", return_value="nano"), \
         mock.patch.object(eng, "ensure", return_value="nano"), \
         mock.patch.object(eng, "_nano_transcribe", side_effect=RuntimeError("mps crash")):
        paras = eng.transcribe(wav)
    assert paras and eng.last_info["engine"] == "paraformer", eng.last_info
    assert "mps crash" in eng.last_info.get("nano_failed", "")

    # 双声道把子通道的 cloud_failed / diarizer_failed 汇总到顶层 last_info
    def fake_mono(path, num_spk, hotword, vad_kw):
        if "mn-ch0-" in str(path):
            eng.last_info = {"engine": "nano", "diarizer": "campp", "cloud_failed": "timeout"}
            return [{"spk": 0, "start": 0, "end": 1000, "text": "你好啊朋友"}]
        eng.last_info = {"engine": "nano", "diarizer": "campp", "diarizer_failed": "nemo err"}
        return [{"spk": 0, "start": 2000, "end": 3000, "text": "收到没问题"}]

    eng.transcribe = fake_mono
    stereo = np.zeros((16000 * 4, 2), dtype=np.float32)
    eng._transcribe_stereo(stereo, 16000, "", None)
    assert eng.last_info.get("cloud_failed") == "timeout"
    assert eng.last_info.get("diarizer_failed") == "nemo err"


# ---------- P0 #10 & P1 #7 & P2 #4: ambient 锁、_RingBuffer、僵尸进程清理、peaks.json ----------
def test_ring_buffer_parity_with_ndarray():
    rng = np.random.default_rng(42)
    rb = ambient._RingBuffer()
    ref = np.zeros(0, np.float32)
    ref_base = 0
    for step in range(40):
        chunk = rng.standard_normal(4800).astype(np.float32)
        rb.append(chunk)
        ref = np.concatenate([ref, chunk])
        if step >= 10 and step % 3 == 0:
            keep = rb.end - 20000
            rb.trim_to(keep)
            cut = min(rb.base - ref_base, len(ref))
            if cut > 0:
                ref = ref[cut:]
                ref_base += cut
        assert rb.base == ref_base and len(rb) == len(ref)
        lo = rb.base + 1234
        hi = rb.end - 567
        got = rb.slice(lo, hi)
        want = ref[lo - ref_base:hi - ref_base]
        assert np.array_equal(got, want), "分块环形缓冲切片必须与连续数组逐样本一致"
    assert len(rb.slice(rb.end + 10, rb.end + 100)) == 0


def test_ambient_close_conv_atomicity_and_process_reaping():
    a = object.__new__(ambient.Ambient)
    a.lock = threading.RLock()
    a.cfg = {**ambient.DEFAULTS}
    a.holds = set()
    a._pending_close = set()
    a.voiced = {}
    a.state = ambient.OFF
    a.state_since = time.time()
    a.state_hist = ambient.deque(maxlen=50)
    a.enabled = False
    a.error = ""
    a.level_db = -100.0
    a.fallback = ""
    a.paused_until = 0.0
    a.proc = None
    a.caff = None
    a.viewers = 0
    a.partial = None
    a.last = None
    a.live_rev = 0
    a.discarded = None
    a.q = queue.Queue()
    a._live_cache = {}
    a._segmap_cache = {}

    d = Path(tempfile.mkdtemp(prefix="mn-amb-close-"))
    f = open(d / "a.pcm", "wb")
    a.conv = ambient.Conv("m1", f, 100.0, 100.0)

    # 验证 _close_conv 释放锁时 conv=None、m1 已在 _pending_close 且文件已关
    a._close_conv()
    assert a.conv is None and "m1" in a._pending_close and f.closed

    # 并发读写 holds / _pending_close / state_info 不抛 Set changed size during iteration
    errs = []

    def mutator():
        for i in range(200):
            k = f"k{i % 10}"
            a.hold(k)
            a.release(k)

    def reader():
        try:
            for _ in range(200):
                a.state_info()
                a.status()
        except Exception as e:  # noqa: BLE001
            errs.append(e)

    t1 = threading.Thread(target=mutator)
    t2 = threading.Thread(target=reader)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    assert not errs, f"并发状态读取不应报错：{errs}"

    # _awake(False) 与 _kill_proc 在 terminate 超时后必须 kill 并 wait 回收僵尸进程
    class StubProc:
        def __init__(self, timeout_once=True):
            self.terminated = False
            self.killed = False
            self.wait_calls = 0
            self.timeout_once = timeout_once

        def poll(self):
            return None if not self.killed else -9

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

        def wait(self, timeout=None):
            self.wait_calls += 1
            if self.timeout_once and self.wait_calls == 1:
                raise subprocess.TimeoutExpired("cmd", timeout or 1)
            return 0

    caff = StubProc(timeout_once=True)
    a.caff = caff
    a._awake(False)
    assert a.caff is None and caff.terminated and caff.killed and caff.wait_calls == 2

    ff = StubProc(timeout_once=True)
    a.proc = ff
    a._kill_proc()
    assert a.proc is None and ff.terminated and ff.killed and ff.wait_calls == 2


def test_purge_old_audio_removes_peaks_json():
    meta = store.create(title="旧记录", source="ambient", status="ready",
                        created="2020-01-01T10:00:00")
    mid = meta["id"]
    d = store.mdir(mid)
    for name in ("audio.pcm", "audio.wav", "audio.mp3", "peaks.json"):
        (d / name).write_text("x")
    n = ambient.purge_old_audio(30)
    assert n >= 1
    for name in ("audio.pcm", "audio.wav", "audio.mp3", "peaks.json"):
        assert not (d / name).exists(), f"{name} 应随过期录音一起删除"


# ---------- P1 #2 & P2 #4: context_hotwords & vocab 优化与优先级保护 ----------
def test_context_hotwords_early_exit_cache_and_priority():
    context_hotwords._PN_CACHE.clear()

    # 1) user 已满 limit 时直接早退，不再对 title/notes/history 调 proper_nouns
    with mock.patch.object(context_hotwords, "proper_nouns", side_effect=AssertionError("已满上限不应再切词")):
        out = context_hotwords.merge_hotwords([f"词{i:02d}" for i in range(30)],
                                              title="项目评审", notes="观远数据", history=["预算池", "预算池"], limit=30)
    assert len(out) == 30

    # 2) proper_nouns 命中 LRU 缓存，不重复调 pseg.cut
    context_hotwords._ensure_pseg()
    text = "今天讨论了观远数据平台和千川投放的架构设计。"
    with mock.patch.object(context_hotwords.pseg, "cut", wraps=context_hotwords.pseg.cut) as spy:
        r1 = context_hotwords.proper_nouns(text)
        r2 = context_hotwords.proper_nouns(text)
    assert r1 == r2 and spy.call_count == 1, f"第二次应命中缓存：{spy.call_count}"

    # 3) 低优先级标题/笔记中的长串不得挤掉高优先级用户热词（含中英混写与纯中文）
    words = context_hotwords.merge_hotwords(["AI", "长尾"], title="关于AI的讨论", title_auto=False,
                                            notes="今天讲了「AI模型」和「长尾词」", history=["「AI模型」", "「AI模型」"])
    assert "AI" in words and "长尾" in words, f"用户显式热词不应被低优先级长串挤掉：{words}"
    assert "关于AI的讨论" not in words and "AI模型" not in words and "长尾词" not in words, words
    # 同优先级（都是用户热词）仍保留更长的词
    same_tier = context_hotwords.merge_hotwords(["长尾", "长尾词"])
    assert same_tier == ["长尾词"], same_tier


def test_vocab_apply_paras_single_load_and_suspects_precompute():
    prev_vocab = vocab.get()
    try:
        vocab.save({"hotwords": "长尾词 以图搜图", "fixes": [{"from": "艾森", "to": "ASIN"}]})
        paras = [{"text": f"第{i}段提到了艾森", "start": i * 1000} for i in range(50)]
        with mock.patch.object(vocab, "_load", wraps=vocab._load) as spy:
            out = vocab.apply_paras(paras)
        assert spy.call_count == 1, f"apply_paras 应只调用一次 _load，实际 {spy.call_count}"
        assert all("ASIN" in p["text"] for p in out)

        # suspects 对每个热词只计算一次多音字 readings，而非每段重算
        tools = vocab._tools()
        read_calls = []
        orig_readings = tools["readings"]

        def count_readings(w):
            read_calls.append(w)
            return orig_readings(w)

        with mock.patch.dict(tools, {"readings": count_readings}):
            ps = [{"text": "陈伟驰说你不说图，常伟奇再看一次陈伟驰。", "start": i * 1000} for i in range(20)]
            hits = vocab.suspects(ps)
        assert len(read_calls) == 2, f"2 个热词只应算 2 次 readings，实际 {len(read_calls)}"
        assert any(h["text"] == "陈伟驰" and h["hotword"] == "长尾词" for h in hits)

        # make_lexicon_corrector 可复用且不产生级联二次替换
        correct = context_hotwords.make_lexicon_corrector("长尾词 以图搜图")
        assert correct("他说的以陈伟驰打流量") == "他说的以长尾词打流量"
        assert correct("你不说图效果怎么样") == "以图搜图效果怎么样"

        # _tools 并发初始化线程安全
        orig_seg = vocab._seg
        vocab._seg = {}
        results = []
        barrier = threading.Barrier(4)

        def init_worker():
            barrier.wait()
            t = vocab._tools()
            results.append(set(t.keys()))

        threads = [threading.Thread(target=init_worker) for _ in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        assert all(keys == {"jieba", "freq", "lazy", "readings"} for keys in results), results
        if not vocab._seg:
            vocab._seg = orig_seg
    finally:
        vocab.save(prev_vocab)


# ---------- P2 #4: doubao_asr & dual_audio ----------
def test_doubao_transcript_and_reset_device():
    tr = doubao_asr._Transcript()
    # 第一句已定稿，第二句只有 interim：text() 应保留尾部未定稿句
    tr.update(json.dumps({"results": [{"index": 0, "text": "我们先看数据。", "is_interim": False, "is_vad_finished": True}]}))
    tr.update(json.dumps({"results": [{"index": 1, "text": "下周再复盘", "is_interim": True, "is_vad_finished": False}]}))
    assert tr.text() == "我们先看数据。下周再复盘", tr.text()
    # 已定稿 index=0 若又收到旧 interim，不应重复拼接
    tr.update(json.dumps({"results": [{"index": 1, "text": "下周再复盘。", "is_interim": False, "is_vad_finished": True}]}))
    tr.update(json.dumps({"results": [{"index": 0, "text": "我们先看数据。", "is_interim": True, "is_vad_finished": False}]}))
    assert tr.text() == "我们先看数据。下周再复盘。", tr.text()

    # _reset_device(expected_did) 仅当磁盘中 did 匹配时才删除，避免并发误删新注册的 did
    store.write_json(doubao_asr.DEVICE_FILE, {"did": "new-did"})
    doubao_asr._reset_device("old-did")
    assert doubao_asr.DEVICE_FILE.exists(), "不匹配的 expected_did 不应删掉新设备 ID"
    doubao_asr._reset_device("new-did")
    assert not doubao_asr.DEVICE_FILE.exists()


def test_dual_audio_drop_bleed_stops_after_dropping_i():
    # a(ch0, rms=0.1) 与 b1(ch1, rms=0.3) 重叠且相似 -> 丢掉 a；
    # b2(ch1, rms=0.02) 也与 a 时间重叠且相似，但已丢掉的 a 不应继续把 b2 干掉
    paras = [
        {"ch": 0, "spk": 0, "start": 0, "end": 4000, "text": "长尾词下周再看效果", "rms": 0.1},
        {"ch": 1, "spk": 1, "start": 0, "end": 2000, "text": "长尾词下周再看效果", "rms": 0.3},
        {"ch": 1, "spk": 1, "start": 2000, "end": 4000, "text": "长尾词下周再看效果", "rms": 0.02},
    ]
    kept = dual_audio.drop_bleed(paras)
    assert len(kept) == 2 and all(p["ch"] == 1 for p in kept), f"已丢弃的 a 不应再删 b2：{kept}"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  ", name)
    print("全部通过")
