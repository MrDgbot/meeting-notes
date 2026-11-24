"""RSI Phase 1 断网测试：拦截所有常见外网出口，遍历全部 RSI 闭环路径，证明 100% 零外网请求。

用法：.venv/bin/python tests/test_rsi_offline.py
"""
import contextlib
import os
import shutil
import socket
import sys
import tempfile
import threading
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

import httpx
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-rsi-off-"))
sys.path.insert(0, str(ROOT))

import app  # noqa: E402
import asr_engine  # noqa: E402
import context_hotwords  # noqa: E402
import rsi_ambient  # noqa: E402
import rsi_events  # noqa: E402
import rsi_vocab  # noqa: E402
import store  # noqa: E402
import vocab  # noqa: E402
import voiceprints  # noqa: E402


def _block_network(*args, **kwargs):
    raise RuntimeError(f"OFFLINE_VIOLATION: RSI attempted outbound network call: {args[:2]}")


@contextlib.contextmanager
def _strict_offline_and_isolated():
    tmp = Path(tempfile.mkdtemp(prefix="mn-rsi-off-iso-"))
    old_data = store.DATA
    old_meetings = store.MEETINGS
    old_discarded = store.DISCARDED
    old_settings = store.SETTINGS
    old_vocab_path = vocab.PATH
    old_daily = app.DAILY
    store.DATA = tmp
    store.MEETINGS = tmp / "meetings"
    store.MEETINGS.mkdir(parents=True, exist_ok=True)
    store.DISCARDED = tmp / "discarded"
    store.SETTINGS = tmp / "settings.json"
    vocab.PATH = tmp / "vocab.json"
    app.DAILY = tmp / "daily"
    store._meta_cache.clear()
    vocab.invalidate()
    with app._suspect_lock:
        app._suspect_cache.clear()
    try:
        with mock.patch.object(socket, "create_connection", side_effect=_block_network), \
             mock.patch.object(socket.socket, "connect", side_effect=_block_network), \
             mock.patch.object(socket.socket, "connect_ex", side_effect=_block_network), \
             mock.patch.object(urllib.request, "urlopen", side_effect=_block_network), \
             mock.patch.object(httpx, "get", side_effect=_block_network), \
             mock.patch.object(httpx, "post", side_effect=_block_network), \
             mock.patch.object(httpx.Client, "send", side_effect=_block_network), \
             mock.patch.object(httpx.AsyncClient, "send", side_effect=_block_network):
            yield tmp
    finally:
        store.DATA = old_data
        store.MEETINGS = old_meetings
        store.DISCARDED = old_discarded
        store.SETTINGS = old_settings
        vocab.PATH = old_vocab_path
        app.DAILY = old_daily
        store._meta_cache.clear()
        vocab.invalidate()
        with app._suspect_lock:
            app._suspect_cache.clear()
        shutil.rmtree(tmp, ignore_errors=True)


def _vec(dim: int, idx: int) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float64)
    v[idx % dim] = 1.0
    return v


def test_all_rsi_phase1_paths_strictly_offline():
    with _strict_offline_and_isolated():
        # 先验证网络封锁确实生效
        try:
            socket.create_connection(("example.com", 80), timeout=1)
            raise AssertionError("网络拦截未生效")
        except RuntimeError as e:
            assert "OFFLINE_VIOLATION" in str(e)

        # 1) rsi_events
        rsi_events.save_config({"paused": False, "auto_name": True})
        assert rsi_events.get_config() == {"paused": False, "auto_name": True}
        rsi_events.emit("offline_ping", {"ok": True})
        rsi_events.log_registry({"loop": "E", "action": "offline_check"})
        assert rsi_events.get_registry(5)
        diff = rsi_events.minutes_edit_stats("## 概要\nA", "## 概要\nB")
        assert diff["overall"] > 0

        # 2) Loop A: voiceprints + asr_engine._diarize hook
        v0 = _vec(64, 0)
        v1 = _vec(64, 1)
        chunks = [[i * 0.75, i * 0.75 + 1.5, None] for i in range(22)]
        X = np.stack([v0 for _ in range(22)])
        turns = [(0, 18000, 0)]
        embs = voiceprints.compute_meeting_embs(turns, chunks, X, diarizer="campp")
        assert voiceprints.enroll("m1", 0, "张三", embs)["status"] == "enrolled"
        assert voiceprints.enroll("m2", 0, "张三", embs)["status"] == "enrolled"
        assert voiceprints.enroll("m3", 0, "张三", {
            "speakers": {"0": {"centroid": v1.tolist(), "n_chunks": 20, "voiced_s": 30.0, "intra_cos_mean": 0.9}}
        })["status"] == "conflict"
        matched = voiceprints.match_meeting(embs, auto_name=True, mid="m4")
        assert matched["auto"]["0"]["name"] == "张三"
        assert voiceprints.known_names() == ["张三"]
        voiceprints.record_override("m4", 0, "张三", "李四")
        voiceprints.record_override("m5", 0, "张三", "王五")
        assert voiceprints.summary()["tau_auto"] == 0.72
        voiceprints.revoke_meeting("m2", 0)

        # 3) Loop B: vocab + rsi_vocab + context_hotwords + Engine._nano CTC hook
        vocab.save({"hotwords": "长尾词", "fixes": [{"from": "艾森", "to": "ASIN"}]})
        rsi_vocab.record_hits([{"text": "艾森"}], vocab.get()["fixes"])
        rsi_vocab.record_edit("m1", "找艾森", "找ASIN", "找艾森", vocab.get()["fixes"])
        assert rsi_vocab.is_suspect_only("艾森")
        assert vocab.apply("找艾森") == "找艾森"
        assert vocab.suspects([{"text": "找艾森和陈伟驰", "start": 0}])
        rsi_vocab.dismiss_suspect("长尾词", "陈伟驰")
        assert rsi_vocab.is_dismissed("长尾词", "陈伟驰")
        rsi_vocab.restore_rule("艾森")
        assert vocab.apply("找艾森") == "找ASIN"

        rsi_vocab.record_edit("m1", "看常伟奇", "看常伟奇", "看长尾词", [])
        rsi_vocab.record_edit("m2", "看常伟奇", "看常伟奇", "看长尾词", [])
        rsi_vocab.accept_candidate("常伟奇", "长尾词", hotword=True)
        rsi_vocab.dismiss_candidate("甲乙", "丙丁")

        eng = asr_engine.Engine.__new__(asr_engine.Engine)
        eng.nano_lock = threading.RLock()

        class FakeNano:
            model = None

            def generate(self, input, language="中文", itn=True, **kw):
                if kw.get("hotwords"):
                    return [{"text": "幻觉毒词出现", "ctc_text": "正常语音", "timestamps": []}]
                return [{"text": "正常语音", "ctc_text": "正常语音", "timestamps": []}]

        eng.nano = FakeNano()
        for _ in range(3):
            eng._nano(np.zeros(16000, dtype=np.float32), hotword="幻觉毒词")
        assert "幻觉毒词" in rsi_vocab.demoted_hotwords()
        hw = context_hotwords.merge_hotwords(["保留词"], notes="「幻觉毒词」「观远数据」", history=[("「星云」", 3.0)])
        assert "保留词" in hw and "张三" in hw and "幻觉毒词" not in hw

        # 4) Loop D: rsi_ambient + store 回收站钩子
        rsi_ambient.record_noise_floor("MicA", -45.0)
        rsi_ambient.record_conv_vad("MicA", 8000, 6000)
        m_rec = store.create(title="", source="ambient", status="recording", title_auto=True)
        store.recycle(m_rec["id"], voiced_s=10.0, min_s=20.0, device="MicA")
        store.restore_discarded(m_rec["id"])
        m_prg = store.create(title="", source="ambient", status="recording", title_auto=True)
        store.recycle(m_prg["id"], voiced_s=4.0, min_s=20.0, device="MicA")
        d_info = store.read_json(store.DISCARDED / m_prg["id"] / "discard.json")
        d_info["discarded_at"] = (datetime.now() - timedelta(days=9)).isoformat(timespec="seconds")
        store.write_json(store.DISCARDED / m_prg["id"] / "discard.json", d_info)
        store.purge_discarded()
        for i in range(20):
            rsi_ambient.record_discard_outcome(f"off_{i}", 11.0 if i < 12 else 4.0, 20.0,
                                               "restored" if i < 12 else "purged_7d")
        assert rsi_ambient.advice(20.0)["suggested_min_speech_s"] == 15.0

        # 5) app.py 全部 RSI 端点与 /api/state
        m_api = store.create(title="离线会", status="ready", speakers={"0": "张三"},
                             speaker_meta={"auto": {"0": {"name": "张三", "score": 0.9, "margin": 0.4, "source": "voiceprint_auto"}},
                                           "suggest": {}, "merge_hints": []})
        store.save(m_api["id"], "spk_embs.json", embs)
        store.save(m_api["id"], "transcript.json", {"paragraphs": [{"spk": 0, "start": 0, "end": 1000, "text": "找艾森"}]})
        store.save(m_api["id"], "minutes.json", {"markdown": "## 概要\n旧"})
        app.edit_paragraph(m_api["id"], 0, {"text": "找艾森"})
        app.patch_meeting(m_api["id"], {"minutes_markdown": "## 概要\n新"})
        app.undo_rsi_voiceprint({"mid": m_api["id"], "spk": 0})
        payload = app.get_rsi()
        assert "voiceprints" in payload and "vocab" in payload and "ambient" in payload
        assert "rsi" in app.app_state()
        app.reset_rsi({"scope": "all"})
        assert app.get_rsi()["voiceprints"]["persons"] == []


if __name__ == "__main__":
    test_all_rsi_phase1_paths_strictly_offline()
    print("ok   test_all_rsi_phase1_paths_strictly_offline")
    print("全部通过")
