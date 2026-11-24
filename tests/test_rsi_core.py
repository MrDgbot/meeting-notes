"""RSI Phase 1 单元测试与 API 契约测试（纯本地、不加载语音模型、不碰仓库 data/）。

覆盖：
- rsi_events：配置读写、隐私排除（paused / rsi_exclude）、5MB 事件轮转、零原始音频、注册表 200 条上限、纪要分节编辑距离；
- Loop A（voiceprints）：compute_meeting_embs 重叠块剔除与 L2 质心、泛称过滤、质量门禁、防投毒冲突隔离、按场可逆撤销、
  贪心 1 对 1 匹配（auto / suggest / merge_hints）、run_transcribe 自动命名、undo 接口与哨兵抬高 tau_auto / 退回仅建议；
- Loop B（rsi_vocab + vocab + context_hotwords）：edit_paragraph 快照 orig_text、规则撤回自动降级 suspect_only 与恢复、
  跨场短词候选挖掘/采纳/忽略、疑似热词忽略黑名单、CTC 拒绝率淘汰毒热词、声纹人名注入热词与历史人工权重；
- Loop D（rsi_ambient + store + ambient）：设备底噪与 VAD 误触、回收站 restore/purge 与删短录反馈、
  非对称代价 min_speech_s 建议（±5s 步长）与 7 天恢复哨兵预警；
- 隐私隔离（rsi_exclude / paused）、重置端点（/api/rsi/reset）、/api/state RSI 摘要与全套 ASGI 路由校验。

用法：.venv/bin/python tests/test_rsi_core.py
"""
import asyncio
import contextlib
import json
import os
import shutil
import sys
import tempfile
import threading
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock
from urllib.parse import quote, unquote

from fastapi.testclient import TestClient

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-rsi-core-"))
sys.path.insert(0, str(ROOT))

import ambient  # noqa: E402
import app  # noqa: E402
import asr_engine  # noqa: E402
import context_hotwords  # noqa: E402
import lan  # noqa: E402
import rsi_ambient  # noqa: E402
import rsi_events  # noqa: E402
import rsi_vocab  # noqa: E402
import store  # noqa: E402
import vocab  # noqa: E402
import voiceprints  # noqa: E402


@contextlib.contextmanager
def _isolated_data():
    """每个测试使用完全独立的临时数据目录，避免污染仓库 data/ 或其他单测。"""
    tmp = Path(tempfile.mkdtemp(prefix="mn-rsi-iso-"))
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
    with app._search_lock:
        app._search_cache.clear()
    try:
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
        with app._search_lock:
            app._search_cache.clear()
        shutil.rmtree(tmp, ignore_errors=True)


def _basis(dim: int, idx: int, noise: float = 0.0, seed: int = 0) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float64)
    v[idx % dim] = 1.0
    if noise > 0:
        rng = np.random.default_rng(seed)
        v += rng.normal(0.0, noise, size=dim)
    return v / np.linalg.norm(v)


def _make_spk_embs(vec: np.ndarray, *, spk: str = "0", voiced_s: float = 30.0,
                   n_chunks: int = 20, intra: float = 0.88) -> dict:
    u = np.asarray(vec, dtype=np.float64)
    u = u / np.linalg.norm(u)
    return {
        "version": 1,
        "diarizer": "campp",
        "dim": int(u.size),
        "speakers": {
            spk: {
                "centroid": [round(float(x), 6) for x in u],
                "n_chunks": n_chunks,
                "voiced_s": voiced_s,
                "intra_cos_mean": intra,
                "intra_cos_p25": round(intra - 0.05, 4),
            }
        },
    }


async def _asgi_hit(method: str, path: str, body: dict | None = None):
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else b""
    got = {"status": 0, "body": b""}
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            got["status"] = msg["status"]
        elif msg["type"] == "http.response.body":
            got["body"] += msg.get("body") or b""

    headers = [(b"host", b"127.0.0.1"), (b"origin", b"http://127.0.0.1")]
    if body is not None:
        headers.append((b"content-type", b"application/json"))
    raw_path, sep, raw_qs = path.partition("?")
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": unquote(raw_path), "raw_path": raw_path.encode(),
        "query_string": raw_qs.encode() if sep else b"", "headers": headers, "client": ("127.0.0.1", 9),
        "server": ("127.0.0.1", 80), "root_path": "",
    }
    await lan.Guard(app.app)(scope, receive, send)
    payload = json.loads(got["body"].decode("utf-8")) if got["body"] else None
    return got["status"], payload


def test_rsi_events_config_rotation_registry_and_minutes_diff():
    with _isolated_data():
        cfg = rsi_events.get_config()
        assert cfg == {"paused": False, "auto_name": True}
        assert not rsi_events.is_excluded({})
        assert rsi_events.is_excluded({"rsi_exclude": True})

        rsi_events.save_config({"paused": True})
        assert rsi_events.is_excluded({"rsi_exclude": False})
        rsi_events.save_config({"paused": False, "auto_name": False})
        assert rsi_events.get_config() == {"paused": False, "auto_name": False}

        # 事件流禁止写原始音频，并支持按体积轮转（只保留 1 份 .1）
        with mock.patch.object(rsi_events, "MAX_EVENT_BYTES", 200):
            for i in range(10):
                rsi_events.emit("unit_test", {"i": i, "audio": b"RAW_AUDIO_BYTES", "raw": b"123", "msg": "x" * 40})
        ev_path = rsi_events._dir() / "events.jsonl"
        rot_path = rsi_events._dir() / "events.jsonl.1"
        assert ev_path.exists() and rot_path.exists()
        content = ev_path.read_text("utf-8") + rot_path.read_text("utf-8")
        assert "RAW_AUDIO_BYTES" not in content and '"audio"' not in content

        # 注册表上限 200 条，get_registry 倒序返回最新记录
        for i in range(215):
            rsi_events.log_registry({"loop": "E", "action": f"act_{i}"})
        all_reg = rsi_events.get_registry(limit=300)
        assert len(all_reg) == 200
        assert all_reg[0]["action"] == "act_214"
        assert len(rsi_events.get_registry(limit=30)) == 30

        # 纪要分节编辑距离
        orig = "# 周会\n\n## 概要\n今天讨论了架构。\n\n## 待办\n- 张三周五前提交方案\n"
        edited = "# 周会\n\n## 概要\n今天讨论了架构。\n\n## 待办\n- 李四下周一前提交最终方案并评审\n\n## 风险\n- 排期偏紧\n"
        stats = rsi_events.minutes_edit_stats(orig, edited)
        assert stats["changed"] is True and 0.0 < stats["overall"] < 1.0
        assert stats["sections"]["概要"] == 0.0
        assert stats["sections"]["待办"] > 0.0
        assert stats["sections"]["风险"] == 1.0


def test_loop_a_compute_enroll_conflict_revoke_match_merge_hints():
    with _isolated_data():
        # 1) compute_meeting_embs：剔除多说话人重叠块，不因 0.75s 滑窗双倍计数 voiced_s
        v0 = _basis(64, 0)
        v1 = _basis(64, 1)
        garbage = _basis(64, 20)
        turns = [(0, 18000, 0), (18000, 36000, 1)]
        chunks = []
        vecs = []
        # 20 个纯净 spk0 块（覆盖 0..15.75s）
        for i in range(20):
            s = i * 0.75
            chunks.append([s, s + 1.5, None])
            vecs.append(v0 + _basis(64, (i % 5) + 30) * 0.05)
        # 1 个跨边界重叠块（17.25..18.75s 同时覆盖 spk0 与 spk1）带脏向量：必须剔除
        chunks.append([17.25, 18.75, None])
        vecs.append(garbage)
        # 16 个纯净 spk1 块（覆盖 19.0..31.75s）
        for i in range(16):
            s = 19.0 + i * 0.75
            chunks.append([s, s + 1.5, None])
            vecs.append(v1 + _basis(64, (i % 5) + 40) * 0.05)

        embs = voiceprints.compute_meeting_embs(turns, chunks, np.stack(vecs), diarizer="campp")
        assert embs["dim"] == 64 and set(embs["speakers"]) == {"0", "1"}
        s0 = embs["speakers"]["0"]
        assert s0["n_chunks"] == 20, f"重叠脏块应被剔除，实际 {s0['n_chunks']}"
        assert 15.5 <= s0["voiced_s"] <= 16.0, f"并集时长不应因重叠滑窗翻倍：{s0['voiced_s']}"
        assert abs(np.linalg.norm(s0["centroid"]) - 1.0) < 1e-4
        assert float(np.dot(s0["centroid"], garbage)) < 0.05
        assert s0["intra_cos_mean"] > 0.95 and s0["intra_cos_p25"] > 0.90

        # 2) enroll 泛称过滤与质量门禁
        for bad_name in ("", "说话人1", "说话人 2", "我", "对方", "主持人", "待定"):
            r = voiceprints.enroll("m0", 0, bad_name, embs)
            assert r["status"] == "skipped" and r["reason"] == "generic_name", (bad_name, r)

        low_q = _make_spk_embs(v0, voiced_s=10.0, n_chunks=12, intra=0.8)
        assert voiceprints.enroll("m0", 0, "张三", low_q)["reason"] == "quality_gate"
        low_c = _make_spk_embs(v0, voiced_s=20.0, n_chunks=5, intra=0.8)
        assert voiceprints.enroll("m0", 0, "张三", low_c)["reason"] == "quality_gate"
        low_i = _make_spk_embs(v0, voiced_s=20.0, n_chunks=12, intra=0.40)
        assert voiceprints.enroll("m0", 0, "张三", low_i)["reason"] == "quality_gate"

        # 3) 正常注册：张三 2 场，李四 1 场
        r1 = voiceprints.enroll("m1", 0, "张三", _make_spk_embs(v0, voiced_s=30.0))
        r2 = voiceprints.enroll("m2", 0, "张三", _make_spk_embs(v0 + 0.05 * _basis(64, 5), voiced_s=40.0))
        r3 = voiceprints.enroll("m1", 1, "李四", _make_spk_embs(v1, spk="1", voiced_s=30.0))
        assert r1["status"] == "enrolled" and r2["sessions"] == 2 and r3["sessions"] == 1

        # 4) 防投毒冲突隔离：低自相似（s_self < 0.45）与更像他人（s_other > s_self + 0.05）
        c_low = voiceprints.enroll("m3", 0, "张三", _make_spk_embs(_basis(64, 9), voiced_s=30.0))
        assert c_low["status"] == "conflict" and c_low["reason"] == "low_self_similarity"
        mix_closer_lisi = 0.55 * v0 + 0.83 * v1  # s_self ~0.55 (>=0.45), s_other ~0.83 (> s_self+0.05)
        c_other = voiceprints.enroll("m4", 0, "张三", _make_spk_embs(mix_closer_lisi, voiced_s=30.0))
        assert c_other["status"] == "conflict" and c_other["reason"] == "closer_to_other"
        assert len(voiceprints.summary()["conflicts"]) == 2
        assert next(p for p in voiceprints.summary()["persons"] if p["name"] == "张三")["sessions"] == 2

        # 5) match_meeting：张三(2场)->auto，李四(1场)->suggest，同人双簇->merge_hints
        query = {
            "speakers": {
                "0": _make_spk_embs(v0)["speakers"]["0"],
                "1": _make_spk_embs(v1, spk="1")["speakers"]["1"],
                "2": _make_spk_embs(v0 + 0.03 * _basis(64, 8), spk="2")["speakers"]["2"],
            }
        }
        m = voiceprints.match_meeting(query, auto_name=True)
        assert "0" in m["auto"] and m["auto"]["0"]["name"] == "张三"
        assert "1" in m["suggest"] and m["suggest"]["1"]["name"] == "李四" and "1" not in m["auto"]
        assert len(m["merge_hints"]) == 1
        assert set(m["merge_hints"][0]["spks"]) == {0, 2} and m["merge_hints"][0]["name"] == "张三"

        # auto_name=False 时全部退回 suggest
        m_off = voiceprints.match_meeting(query, auto_name=False)
        assert m_off["auto"] == {} and m_off["suggest"]["0"]["name"] == "张三"

        # 6) 按场确定性撤销与删除人物
        assert voiceprints.revoke_meeting("m2", 0) == 1
        assert next(p for p in voiceprints.summary()["persons"] if p["name"] == "张三")["sessions"] == 1
        assert voiceprints.revoke_meeting("m1", 0) == 1
        assert all(p["name"] != "张三" for p in voiceprints.summary()["persons"])
        assert voiceprints.delete_person("李四") is True
        assert voiceprints.delete_person("李四") is False


def test_loop_a_run_transcribe_undo_and_sentinel():
    with _isolated_data():
        v0 = _basis(64, 0)
        voiceprints.enroll("hist1", 0, "王敏", _make_spk_embs(v0))
        voiceprints.enroll("hist2", 0, "王敏", _make_spk_embs(v0 + 0.02 * _basis(64, 2)))

        # run_transcribe 自动保存 spk_embs.json 并自动命名未命名说话人
        m1 = store.create(title="项目周会", source="upload")
        mid1 = m1["id"]
        (store.mdir(mid1) / "audio.wav").write_bytes(b"RIFF")

        def fake_transcribe(wav, num_spk, hotword, vad_kw):
            app.engine.last_info = {"engine": "nano", "diarizer": "campp"}
            app.engine.last_spk_embs = _make_spk_embs(v0)
            return [{"spk": 0, "start": 0, "end": 5000, "text": "大家好我是王敏"}]

        orig_ready = app.engine.ready
        try:
            app.engine.ready = True
            with mock.patch.object(app, "duration_of", return_value=25.0), \
                 mock.patch.object(app, "make_mp3"), \
                 mock.patch.object(app.engine, "transcribe", side_effect=fake_transcribe), \
                 mock.patch.object(app.minutes_jobs, "submit"):
                app.run_transcribe(mid1)
        finally:
            app.engine.ready = orig_ready

        assert (store.mdir(mid1) / "spk_embs.json").exists()
        meta1 = store.get(mid1)
        assert meta1["speakers"].get("0") == "王敏"
        assert meta1["speaker_meta"]["auto"]["0"]["source"] == "voiceprint_auto"

        # 第一次撤销：移掉名字、记录 override，尚未触发哨兵
        u1 = app.undo_rsi_voiceprint({"mid": mid1, "spk": 0})
        assert "0" not in u1["speakers"] and "0" not in (u1.get("speaker_meta", {}).get("auto") or {})
        assert voiceprints.summary()["tau_auto"] == 0.68

        # 第二次在另一场自动命名会议撤销：触发哨兵，tau_auto 0.68 -> 0.72 并记入 registry.json
        m2 = store.create(title="复盘会", source="upload", speakers={"0": "王敏"},
                          speaker_meta={"auto": {"0": {"name": "王敏", "score": 0.9, "margin": 0.5, "source": "voiceprint_auto"}},
                                        "suggest": {}, "merge_hints": []})
        voiceprints.record_auto_named(m2["id"])
        app.undo_rsi_voiceprint({"mid": m2["id"], "spk": 0})
        assert voiceprints.summary()["tau_auto"] == 0.72
        assert any(r.get("action") == "sentinel_raise_tau_auto" for r in rsi_events.get_registry())

        # 当 tau_auto >= 0.80 且再次发生 >= 2 次撤回时，自动关闭 auto_name 并记录回滚
        db = voiceprints._load_db()
        db["tau_auto"] = 0.80
        voiceprints._save_db(db)
        voiceprints.record_override("m3", 0, "王敏", "赵六")
        res = voiceprints.record_override("m4", 0, "王敏", "孙七")
        assert res["sentinel"]["action"] == "disable_auto_name"
        assert rsi_events.get_config()["auto_name"] is False
        assert any(r.get("action") == "sentinel_disable_auto_name" for r in rsi_events.get_registry())

        # patch_meeting 改名注册新声纹；delete_meeting 撤销声纹
        m5 = store.create(title="评审", source="mic")
        store.save(m5["id"], "spk_embs.json", _make_spk_embs(_basis(64, 7)))
        app.patch_meeting(m5["id"], {"speakers": {"0": "陈雷"}})
        assert any(p["name"] == "陈雷" for p in voiceprints.summary()["persons"])
        app.delete_meeting(m5["id"])
        assert all(p["name"] != "陈雷" for p in voiceprints.summary()["persons"])


def test_loop_b_rule_revert_demote_restore_and_candidate_mining():
    with _isolated_data():
        vocab.save({"hotwords": "长尾词", "fixes": [
            {"from": "艾森", "to": "ASIN"},
            {"from": "陈伟驰", "to": "长尾词"},
        ]})

        # 1) 低精度规则（hits=1, reverts=1 -> precision=0.50 < 0.70）自动降级为 suspect_only
        rsi_vocab.record_hits([{"text": "看一下艾森的数据"}], vocab.get()["fixes"])
        m1 = store.create(title="销售会", status="ready")
        store.save(m1["id"], "transcript.json", {
            "paragraphs": [{"spk": 0, "start": 1000, "end": 4000, "text": "同事艾森刚才发言了"}]
        })
        assert vocab.apply("同事艾森刚才发言了") == "同事ASIN刚才发言了"
        # 用户手动把被规则误改成的 ASIN 改回 艾森
        app.edit_paragraph(m1["id"], 0, {"text": "同事艾森刚才发言了"})
        tr1 = store.load(m1["id"], "transcript.json")
        assert tr1["paragraphs"][0]["orig_text"] == "同事艾森刚才发言了"
        assert rsi_vocab.is_suspect_only("艾森")
        # 降级后不再自动替换，但会在 suspects() 中提示
        assert vocab.apply("艾森明天出差") == "艾森明天出差"
        sus = vocab.suspects([{"text": "艾森明天出差", "start": 2000}])
        assert any(x["text"] == "艾森" and x["hotword"] == "ASIN" for x in sus)
        assert any(r.get("action") == "sentinel_demote_rule" for r in rsi_events.get_registry())

        # 一键恢复规则：重新生效
        assert app.restore_rsi_rule({"from": "艾森"}) == {"ok": True}
        assert not rsi_vocab.is_suspect_only("艾森")
        assert vocab.apply("艾森的流量") == "ASIN的流量"

        # 2) 高命中规则（hits=5）：1 次撤回（5/6=0.83>=0.70）不降级，第 2 次撤回（reverts>=2）才降级
        rsi_vocab.record_hits([{"text": "陈伟驰 " * 5}], vocab.get()["fixes"])
        r_one = rsi_vocab.record_edit("ma", "看陈伟驰", "看长尾词", "看陈伟驰", vocab.get()["fixes"])
        assert not r_one["demoted"] and not rsi_vocab.is_suspect_only("陈伟驰")
        r_two = rsi_vocab.record_edit("mb", "看陈伟驰", "看长尾词", "看陈伟驰", vocab.get()["fixes"])
        assert "陈伟驰" in r_two["demoted"] and rsi_vocab.is_suspect_only("陈伟驰")

        # 3) 跨 >= 2 场改字挖掘短词候选 + 采纳/忽略接口
        rsi_vocab.record_edit("c1", "看常伟奇流量", "看常伟奇流量", "看长尾词流量", [])
        assert rsi_vocab.summary()["candidates"] == []  # 单场还不够 2 场
        rsi_vocab.record_edit("c2", "再查常伟奇数据", "再查常伟奇数据", "再查长尾词数据", [])
        rsi_vocab.record_edit("c1", "测试卡夫卡集群", "测试卡夫卡集群", "测试Kafka集群", [])
        rsi_vocab.record_edit("c2", "部署卡夫卡节点", "部署卡夫卡节点", "部署Kafka节点", [])
        cands = {(c["from"], c["to"]) for c in rsi_vocab.summary()["candidates"]}
        assert ("常伟奇", "长尾词") in cands and ("卡夫卡", "Kafka") in cands

        app.accept_rsi_candidate({"from": "常伟奇", "to": "长尾词", "hotword": True})
        assert any(f["from"] == "常伟奇" and f["to"] == "长尾词" for f in vocab.get()["fixes"])
        assert all(c["from"] != "常伟奇" for c in rsi_vocab.summary()["candidates"])

        app.dismiss_rsi_candidate({"from": "卡夫卡", "to": "Kafka"})
        assert all(c["from"] != "卡夫卡" for c in rsi_vocab.summary()["candidates"])


def test_loop_b_suspect_dismiss_ctc_demote_and_context_hotwords():
    with _isolated_data():
        vocab.save({"hotwords": "长尾词", "fixes": []})
        m = store.create(title="运营会", status="ready")
        store.save(m["id"], "transcript.json", {
            "paragraphs": [{"spk": 0, "start": 1000, "end": 4000, "text": "以陈伟驰打流量"}]
        })
        s1 = app._suspects(m["id"], store.get(m["id"]))
        assert any(x["text"] == "陈伟驰" and x["hotword"] == "长尾词" for x in s1)

        # 忽略该疑似词后，缓存即时失效且不再提示
        app.dismiss_rsi_suspect({"hotword": "长尾词", "text": "陈伟驰"})
        assert rsi_vocab.is_dismissed("长尾词", "陈伟驰")
        s2 = app._suspects(m["id"], store.get(m["id"]))
        assert not any(x["text"] == "陈伟驰" and x["hotword"] == "长尾词" for x in s2)

        # Engine._nano CTC 核验上报：拒绝 >= 3 且拒绝率 > 35% 自动淘汰出自动热词池
        eng = asr_engine.Engine.__new__(asr_engine.Engine)
        eng.nano_lock = threading.RLock()

        class FakeNano:
            model = None

            def generate(self, input, language="中文", itn=True, **kw):
                hws = kw.get("hotwords") or []
                if "毒热词" in hws:
                    return [{"text": "今天说毒热词很好", "ctc_text": "今天天气很好", "timestamps": []}]
                if "长尾词" in hws:
                    return [{"text": "今天看长尾词数据", "ctc_text": "今天看长尾词数据", "timestamps": []}]
                return [{"text": "今天天气很好", "ctc_text": "今天天气很好", "timestamps": []}]

        eng.nano = FakeNano()
        for _ in range(3):
            eng._nano(np.zeros(16000, dtype=np.float32), hotword="毒热词")
        eng._nano(np.zeros(16000, dtype=np.float32), hotword="长尾词")
        assert "毒热词" in rsi_vocab.demoted_hotwords()
        assert "长尾词" not in rsi_vocab.demoted_hotwords()

        # 声纹库常见人名自动注入热词，且淘汰热词从非用户显式来源过滤（但用户显式热词保留）
        voiceprints.enroll("vp1", 0, "周杰伦", _make_spk_embs(_basis(64, 3)))
        merged = context_hotwords.merge_hotwords(
            user=["主词"],
            title="关于「毒热词」评审",
            title_auto=False,
            speakers={"0": "林夕"},
            notes="笔记写了「毒热词」和「观远数据」",
            history=[("笔记含「毒热词」", 3.0), ("另一场「毒热词」", 3.0)],
        )
        assert merged[0] == "主词" and merged[1] == "林夕" and "周杰伦" in merged
        assert merged.index("林夕") < merged.index("周杰伦")
        assert "毒热词" not in merged and "观远数据" in merged

        explicit = context_hotwords.merge_hotwords(user=["毒热词"])
        assert "毒热词" in explicit

        # 历史权重：人工笔记/手改段落优先于未校对原始 ASR
        h1 = store.create(title="会议 01-01 10:00", title_auto=True, status="ready")
        store.write_text(store.mdir(h1["id"]) / "notes.md", "重点跟进「星云引擎」进展")
        store.save(h1["id"], "transcript.json", {"paragraphs": [
            {"spk": 0, "start": 0, "end": 1000, "text": "未校对里反复提到「噪声专名」"},
        ]})
        h2 = store.create(title="会议 01-02 10:00", title_auto=True, status="ready")
        store.save(h2["id"], "transcript.json", {"paragraphs": [
            {"spk": 0, "start": 0, "end": 1000, "text": "未校对里又出现「噪声专名」"},
        ]})
        cur = store.create(title="新会", title_auto=True)
        hist = app._history_texts(cur["id"])
        ranked = context_hotwords.merge_hotwords([], history=hist, gallery_names=[])
        assert "星云引擎" in ranked and "噪声专名" in ranked
        assert ranked.index("星云引擎") < ranked.index("噪声专名"), f"笔记专名应排在原始 ASR 前面：{ranked}"


def test_loop_d_acoustic_profile_discards_advice_and_sentinel():
    with _isolated_data():
        # 底噪与 VAD 误触统计
        rsi_ambient.record_noise_floor("MacBook Mic", -48.0)
        rsi_ambient.record_noise_floor("MacBook Mic", -44.0)
        rsi_ambient.record_conv_vad("MacBook Mic", 10000, 7500)
        sm = rsi_ambient.summary(20.0)
        assert len(sm["devices"]) == 1
        assert sm["devices"][0]["p10_db"] == -46.0
        assert sm["devices"][0]["noise_floor_p20_db"] == -46.0
        assert sm["devices"][0]["samples"] == 2
        assert sm["devices"][0]["vad_false_ratio"] == 0.25

        # store.restore_discarded & store.purge_discarded 钩子
        m_res = store.create(title="", source="ambient", status="recording", title_auto=True)
        store.recycle(m_res["id"], voiced_s=14.0, min_s=20.0, device="MacBook Mic")
        store.restore_discarded(m_res["id"])

        m_prg = store.create(title="", source="ambient", status="recording", title_auto=True)
        store.recycle(m_prg["id"], voiced_s=6.0, min_s=20.0, device="MacBook Mic")
        info = store.read_json(store.DISCARDED / m_prg["id"] / "discard.json")
        info["discarded_at"] = (datetime.now() - timedelta(days=8)).isoformat(timespec="seconds")
        store.write_json(store.DISCARDED / m_prg["id"] / "discard.json", info)
        store.purge_discarded()

        # delete_meeting：未编辑短全天录记为 user_deleted_short；有笔记或长录音不记
        m_del_short = store.create(title="自动记录 10:00", source="ambient", status="ready",
                                   title_auto=True, duration=32.0, speech_s=24.0)
        app.delete_meeting(m_del_short["id"])

        m_del_edited = store.create(title="重要沟通", source="ambient", status="ready",
                                    title_auto=False, duration=30.0, speech_s=24.0)
        app.delete_meeting(m_del_edited["id"])

        st = rsi_ambient.summary(20.0)["discard_stats"]
        assert st["restored"] == 1 and st["purged_7d"] == 1 and st["user_deleted_short"] == 1
        adv_few = rsi_ambient.advice(20.0)
        assert adv_few["suggested_min_speech_s"] is None and adv_few["need_more"] == 17

        # 凑足 >= 20 条样本，且大量 12s 对话被恢复 -> 建议调低并钳位在 -5s（20 -> 15），同时触发 7 天恢复预警
        for i in range(12):
            rsi_ambient.record_discard_outcome(f"r_{i}", 12.0, 20.0, "restored")
        for i in range(8):
            rsi_ambient.record_discard_outcome(f"p_{i}", 4.0, 20.0, "purged_7d")
        adv_low = rsi_ambient.advice(20.0)
        assert adv_low["suggested_min_speech_s"] == 15.0, adv_low
        assert adv_low["warning"] != ""
        assert any(r.get("action") == "sentinel_restore_warning" for r in rsi_events.get_registry())

        # 重置后测试相反场景：大量 28s 短录被用户手动删除 -> 建议调高并钳位在 +5s（20 -> 25）
        rsi_ambient.reset()
        for i in range(15):
            rsi_ambient.record_discard_outcome(f"d_{i}", 28.0, 20.0, "user_deleted_short")
        for i in range(6):
            rsi_ambient.record_discard_outcome(f"p2_{i}", 8.0, 20.0, "purged_7d")
        adv_hi = rsi_ambient.advice(20.0)
        assert adv_hi["suggested_min_speech_s"] == 25.0, adv_hi
        assert adv_hi["warning"] == ""


def test_privacy_reset_and_api_contract():
    with _isolated_data():
        # 1) 单场隐私排除 rsi_exclude：立即撤销已注册声纹并阻断后续学习
        m = store.create(title="高密会", status="ready")
        mid = m["id"]
        store.save(mid, "spk_embs.json", _make_spk_embs(_basis(64, 4)))
        store.save(mid, "transcript.json", {
            "paragraphs": [{"spk": 0, "start": 0, "end": 2000, "text": "原句常伟奇"}]
        })
        store.save(mid, "minutes.json", {"markdown": "# 会\n\n## 概要\n原纪要"})
        app.patch_meeting(mid, {"speakers": {"0": "高管甲"}})
        assert any(p["name"] == "高管甲" for p in voiceprints.summary()["persons"])

        app.patch_meeting(mid, {"rsi_exclude": True})
        assert store.get(mid)["rsi_exclude"] is True
        assert all(p["name"] != "高管甲" for p in voiceprints.summary()["persons"])

        # 开启 rsi_exclude 后，改名/改字/改纪要都不学习
        app.patch_meeting(mid, {"speakers": {"0": "高管乙"}, "minutes_markdown": "# 会\n\n## 概要\n新纪要"})
        assert voiceprints.summary()["persons"] == []
        mn = store.load(mid, "minutes.json")
        assert mn["orig_markdown"] == "# 会\n\n## 概要\n原纪要"  # 快照仍保留，但不记入学习事件

        # 2) 非排除会议改纪要触发 minutes_edit 事件与 orig_markdown 快照
        m2 = store.create(title="普通会", status="ready")
        store.save(m2["id"], "minutes.json", {"markdown": "# 纪要\n\n## 概要\n旧版"})
        app.patch_meeting(m2["id"], {"minutes_markdown": "# 纪要\n\n## 概要\n修订版"})
        assert store.load(m2["id"], "minutes.json")["orig_markdown"] == "# 纪要\n\n## 概要\n旧版"
        ev_text = (rsi_events._dir() / "events.jsonl").read_text("utf-8")
        assert '"kind":"minutes_edit"' in ev_text

        # 3) 全局 paused=True 阻断一切学习
        app.put_rsi_config({"paused": True})
        rsi_ambient.record_noise_floor("Mic", -50.0)
        rsi_ambient.record_discard_outcome("x1", 5.0, 20.0, "restored")
        rsi_vocab.record_ctc_result([], ["毒词", "毒词", "毒词"])
        assert rsi_ambient.summary(20.0)["devices"] == []
        assert rsi_vocab.demoted_hotwords() == set()
        app.put_rsi_config({"paused": False})

        # 4) 全套 HTTP API 契约 + /api/state RSI 摘要 + /api/rsi/reset
        voiceprints.enroll("api1", 0, "测试人", _make_spk_embs(_basis(64, 11)))
        rsi_ambient.record_noise_floor("USB Mic", -42.0)

        async def run_api():
            st_code, data = await _asgi_hit("GET", "/api/rsi")
            assert st_code == 200
            assert set(data.keys()) == {"config", "voiceprints", "vocab", "ambient", "registry"}
            assert set(data["config"].keys()) == {"paused", "auto_name"}
            assert set(data["voiceprints"].keys()) >= {"tau_auto", "tau_suggest", "persons", "conflicts"}
            assert set(data["vocab"].keys()) >= {"demoted_rules", "candidates", "ctc_demoted", "dismissed_count"}
            assert set(data["ambient"].keys()) >= {"devices", "discard_stats", "advice"}
            assert set(data["ambient"]["discard_stats"].keys()) == {"restored", "purged_7d", "user_deleted_short", "restored_7d"}
            assert set(data["ambient"]["advice"].keys()) >= {"suggested_min_speech_s", "reason", "warning"}

            c2, cfg2 = await _asgi_hit("PUT", "/api/rsi/config", {"auto_name": False})
            assert c2 == 200 and cfg2 == {"paused": False, "auto_name": False}

            c3, st_all = await _asgi_hit("GET", "/api/state")
            assert c3 == 200 and "rsi" in st_all and st_all["rsi"]["config"]["auto_name"] is False

            c4, d_res = await _asgi_hit("DELETE", "/api/rsi/voiceprints/%E6%B5%8B%E8%AF%95%E4%BA%BA")
            assert c4 == 200 and d_res == {"ok": True}

            c5, r_amb = await _asgi_hit("POST", "/api/rsi/reset", {"scope": "ambient"})
            assert c5 == 200 and r_amb["ambient"]["devices"] == []

            c6, r_all = await _asgi_hit("POST", "/api/rsi/reset", {"scope": "all"})
            assert c6 == 200 and r_all["voiceprints"]["persons"] == [] and r_all["registry"] == []

            c_bad, _ = await _asgi_hit("POST", "/api/rsi/reset", {"scope": "invalid"})
            assert c_bad == 400

        asyncio.run(run_api())


def test_asr_diarize_and_ambient_worker_hooks():
    with _isolated_data():
        # 1) Engine._diarize CAM++ 路径顺手产出 last_spk_embs（零额外 GPU 推理）
        eng = asr_engine.Engine.__new__(asr_engine.Engine)
        eng.last_info = {}
        eng.last_spk_embs = None
        v0 = _basis(64, 0)
        fake_chunks = [[i * 0.75, i * 0.75 + 1.5, None] for i in range(16)]
        fake_X = np.stack([v0 for _ in range(16)])
        eng._spk_embeddings = lambda x, segs: (fake_chunks, fake_X)

        class FakeFull:
            cb_model = None

        eng.full = FakeFull()
        with mock.patch.object(asr_engine, "diarizer_mode", return_value="campp"), \
             mock.patch.object(asr_engine, "cluster_speakers", return_value=np.zeros(16, dtype=int)), \
             mock.patch.object(asr_engine, "_sv_postprocess", return_value=[[0.0, 12.75, 0]]):
            turns = eng._diarize(np.zeros(16000, dtype=np.float32), [[0, 12750]], 0)
        assert turns == [(0, 12750, 0)]
        assert eng.last_spk_embs and "0" in eng.last_spk_embs["speakers"]
        assert eng.last_spk_embs["diarizer"] == "campp"
        assert eng.last_spk_embs["speakers"]["0"]["n_chunks"] == 16

        # 2) Engine._diarize pyannote 合并路径同样产出 last_spk_embs
        with mock.patch.object(asr_engine, "diarizer_mode", return_value="pyannote"), \
             mock.patch.object(eng, "_diarize_pyannote", return_value=[(0, 12750, 0)]), \
             mock.patch.object(asr_engine, "merge_turn_speakers", return_value=[(0, 12750, 0)]):
            turns2 = eng._diarize(np.zeros(16000, dtype=np.float32), [[0, 12750]], 0, wav=Path("dummy.wav"))
        assert turns2 == [(0, 12750, 0)]
        assert eng.last_spk_embs and eng.last_spk_embs["diarizer"] == "pyannote"

        # 3) ambient.Ambient._worker close 事件把 (speech_ms, voiced_ms) 记进 rsi_ambient
        a = object.__new__(ambient.Ambient)
        a.lock = threading.RLock()
        a.cfg = {**ambient.DEFAULTS, "device": "Studio Mic", "min_speech_s": 5}
        a.fallback = ""
        a.voiced = {}
        a._pending_close = set()
        a._live_cache = {}
        a._segmap_cache = {}
        a.discarded = None
        closed_ids: list[str] = []
        a.on_closed = closed_ids.append

        m = store.create(title="", source="ambient", status="recording", title_auto=True)
        mid = m["id"]
        a.voiced[mid] = 6000
        a._pending_close.add(mid)

        import queue as _q
        a.q = _q.Queue()
        a.q.put(("close", mid, 10000))

        # 运行一次 _worker 循环体（队列处理完 close 后通过异常跳出）
        orig_get = a.q.get
        calls = 0

        def get_once():
            nonlocal calls
            calls += 1
            if calls == 1:
                return orig_get()
            raise SystemExit

        a.q.get = get_once
        try:
            a._worker()
        except SystemExit:
            pass
        assert closed_ids == [mid]
        devs = {d["device"]: d for d in rsi_ambient.summary(20.0)["devices"]}
        assert "Studio Mic" in devs and devs["Studio Mic"]["vad_convs"] == 1
        assert devs["Studio Mic"]["vad_false_ratio"] == 0.4


def test_search_cache_reflects_rsi_vocab_demote_restore_and_reset():
    """回归测试：/api/search 缓存须感知 Loop B 规则降级、恢复、采纳与重置，不返回陈旧命中。"""
    with _isolated_data():
        vocab.save({"hotwords": "", "fixes": [{"from": "艾森", "to": "ASIN"}]})
        rsi_vocab.record_hits([{"text": "看一下艾森数据"}], vocab.get()["fixes"])

        # m_target 的 transcript.json 全程不改动，专测 _search_cache 的 vocab_sig 与显式失效
        m_target = store.create(title="目标会", status="ready")
        store.save(m_target["id"], "transcript.json", {
            "paragraphs": [{"spk": 0, "start": 0, "end": 3000, "text": "今天提到艾森产品"}]
        })
        m_edit = store.create(title="改字会", status="ready")
        store.save(m_edit["id"], "transcript.json", {
            "paragraphs": [{"spk": 0, "start": 0, "end": 3000, "text": "同事艾森发言"}]
        })

        client = TestClient(lan.Guard(app.app), base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
        hdrs = {"origin": "http://127.0.0.1"}

        def _hit_ids(q: str) -> set[str]:
            r = client.get("/api/search", params={"q": q})
            assert r.status_code == 200
            return {x["id"] for x in r.json()}

        # 初始规则生效：m_target 命中 ASIN，不命中 艾森
        assert m_target["id"] in _hit_ids("ASIN")
        assert m_target["id"] not in _hit_ids("艾森")

        # 1) 在 m_edit 中撤回误替换触发规则自动降级 suspect_only -> m_target 搜索应立即回退为 艾森
        r_ed = client.put(f"/api/meetings/{m_edit['id']}/paragraphs/0", json={"text": "同事艾森发言"}, headers=hdrs)
        assert r_ed.status_code == 200
        assert rsi_vocab.is_suspect_only("艾森")
        assert m_target["id"] not in _hit_ids("ASIN")
        assert m_target["id"] in _hit_ids("艾森")

        # 2) 一键恢复规则 -> m_target 搜索应立即恢复命中 ASIN
        r_res = client.post("/api/rsi/vocab/rule/restore", json={"from": "艾森"}, headers=hdrs)
        assert r_res.status_code == 200
        assert m_target["id"] in _hit_ids("ASIN")
        assert m_target["id"] not in _hit_ids("艾森")

        # 3) 直接通过 rsi_vocab 触发降级（不经 HTTP 清缓存），验证 search() 的 vocab_sig 含 stats_sig()
        rsi_vocab.record_edit("direct_m", "艾森发言", "ASIN发言", "艾森发言", vocab.get()["fixes"])
        assert rsi_vocab.is_suspect_only("艾森")
        assert m_target["id"] not in _hit_ids("ASIN")
        assert m_target["id"] in _hit_ids("艾森")

        # 4) 重置 scope="vocab" 清除降级状态 -> 搜索应立即恢复命中 ASIN
        r_rst = client.post("/api/rsi/reset", json={"scope": "vocab"}, headers=hdrs)
        assert r_rst.status_code == 200
        assert m_target["id"] in _hit_ids("ASIN")
        assert m_target["id"] not in _hit_ids("艾森")

        # 5) 采纳候选规则后搜索也应立即生效
        m_cand = store.create(title="候选会", status="ready")
        store.save(m_cand["id"], "transcript.json", {
            "paragraphs": [{"spk": 0, "start": 0, "end": 3000, "text": "部署卡夫卡集群"}]
        })
        assert m_cand["id"] not in _hit_ids("Kafka")
        r_acc = client.post("/api/rsi/vocab/candidate/accept", json={"from": "卡夫卡", "to": "Kafka"}, headers=hdrs)
        assert r_acc.status_code == 200
        assert m_cand["id"] in _hit_ids("Kafka")
        assert m_cand["id"] not in _hit_ids("卡夫卡")


def test_delete_voiceprint_special_chars_and_slash():
    """回归测试：DELETE /api/rsi/voiceprints/{name:path} 应支持含 /、#、?、空格及中文的姓名。"""
    with _isolated_data():
        names = ["产品/张三", "研发/平台/王五", "李明#1", "Bob?2", "Alice Smith", "张三"]
        for i, name in enumerate(names):
            res = voiceprints.enroll(f"m_{i}", 0, name, _make_spk_embs(_basis(64, i)))
            assert res["status"] == "enrolled", (name, res)

        client = TestClient(lan.Guard(app.app), base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
        hdrs = {"origin": "http://127.0.0.1"}
        for name in names:
            enc = quote(name, safe="")
            r = client.delete(f"/api/rsi/voiceprints/{enc}", headers=hdrs)
            assert r.status_code == 200 and r.json() == {"ok": True}, (name, r.status_code, r.text)
            assert all(p["name"] != name for p in voiceprints.summary()["persons"])
            # 再次删除应返回 404
            r2 = client.delete(f"/api/rsi/voiceprints/{enc}", headers=hdrs)
            assert r2.status_code == 404


def test_undo_and_patch_meeting_prune_speaker_meta_and_guard_override():
    """回归测试：undo 与 patch_meeting 改名应清理陈旧 merge_hints/suggest，且手工命名不应触发哨兵 override。"""
    with _isolated_data():
        # 1) 自动命名 undo：移除 auto/speakers/suggest 与关联 merge_hints，保留无关条目，并记录 override
        m1 = store.create(
            title="自动认人会",
            status="ready",
            speakers={"0": "张三", "1": "李四"},
            speaker_meta={
                "auto": {"0": {"name": "张三", "score": 0.91, "margin": 0.35, "source": "voiceprint_auto"}},
                "suggest": {
                    "0": {"name": "张三", "score": 0.65, "margin": 0.2},
                    "3": {"name": "赵六", "score": 0.62, "margin": 0.2},
                },
                "merge_hints": [
                    {"spks": [0, 2], "name": "张三", "scores": [0.91, 0.84]},
                    {"spks": [1, 3], "name": "李四", "scores": [0.85, 0.80]},
                ],
            },
        )
        voiceprints.record_auto_named(m1["id"])
        u1 = app.undo_rsi_voiceprint({"mid": m1["id"], "spk": 0})
        assert "0" not in u1["speakers"]
        assert "0" not in u1["speaker_meta"]["auto"]
        assert "0" not in u1["speaker_meta"]["suggest"]
        assert "3" in u1["speaker_meta"]["suggest"]
        assert u1["speaker_meta"]["merge_hints"] == [{"spks": [1, 3], "name": "李四", "scores": [0.85, 0.80]}]
        assert len(voiceprints._load_db()["overrides"]) == 1

        # 2) 直接对“手工命名”说话人调用 undo：不得记入 override，也不得触发哨兵抬高 tau_auto
        for idx in range(3):
            mm = store.create(
                title=f"手工命名会{idx}",
                status="ready",
                speakers={"0": "手工甲"},
                speaker_meta={"auto": {}, "suggest": {}, "merge_hints": []},
            )
            res = app.undo_rsi_voiceprint({"mid": mm["id"], "spk": 0})
            assert "0" not in res["speakers"]
        assert len(voiceprints._load_db()["overrides"]) == 1
        assert voiceprints.summary()["tau_auto"] == voiceprints.DEFAULT_TAU_AUTO

        # 3) patch_meeting 改名为不同名字：清理陈旧 merge_hints、suggest 与 auto，保留无关条目
        m2 = store.create(
            title="改名会",
            status="ready",
            speakers={"0": "张三"},
            speaker_meta={
                "auto": {"0": {"name": "张三", "score": 0.90, "margin": 0.3, "source": "voiceprint_auto"}},
                "suggest": {
                    "0": {"name": "张三", "score": 0.63, "margin": 0.15},
                    "2": {"name": "王五", "score": 0.61, "margin": 0.15},
                },
                "merge_hints": [
                    {"spks": [0, 2], "name": "张三", "scores": [0.90, 0.82]},
                    {"spks": [1, 3], "name": "王五", "scores": [0.86, 0.81]},
                ],
            },
        )
        p2 = app.patch_meeting(m2["id"], {"speakers": {"0": "李四"}})
        assert p2["speakers"]["0"] == "李四"
        assert "0" not in p2["speaker_meta"]["auto"]
        assert "0" not in p2["speaker_meta"]["suggest"]
        assert "2" in p2["speaker_meta"]["suggest"]
        assert p2["speaker_meta"]["merge_hints"] == [{"spks": [1, 3], "name": "王五", "scores": [0.86, 0.81]}]

        # 4) patch_meeting 清空说话人姓名：同样清理引用该说话人的陈旧 merge_hints 与匹配 suggest
        m3 = store.create(
            title="清空姓名会",
            status="ready",
            speakers={"0": "张三"},
            speaker_meta={
                "auto": {},
                "suggest": {"0": {"name": "张三", "score": 0.63, "margin": 0.15}},
                "merge_hints": [{"spks": [0, 2], "name": "张三", "scores": [0.88, 0.80]}],
            },
        )
        p3 = app.patch_meeting(m3["id"], {"speakers": {}})
        assert p3["speaker_meta"]["merge_hints"] == []
        assert "0" not in p3["speaker_meta"]["suggest"]

        # 5) patch_meeting 把未命名说话人命名为与 merge_hint 一致的名字：保留 merge_hint，同时清理该说话人 suggest
        m4 = store.create(
            title="确认同人会",
            status="ready",
            speakers={},
            speaker_meta={
                "auto": {},
                "suggest": {"0": {"name": "张三", "score": 0.65, "margin": 0.2}},
                "merge_hints": [{"spks": [0, 2], "name": "张三", "scores": [0.88, 0.81]}],
            },
        )
        p4 = app.patch_meeting(m4["id"], {"speakers": {"0": "张三"}})
        assert "0" not in p4["speaker_meta"]["suggest"]
        assert p4["speaker_meta"]["merge_hints"] == [{"spks": [0, 2], "name": "张三", "scores": [0.88, 0.81]}]


def test_retranscribe_with_rsi_exclude_clears_speaker_meta():
    """回归测试：开启 rsi_exclude=True 后重新转写，应清除此前非隐私轮次留下的 speaker_meta。"""
    with _isolated_data():
        v0 = _basis(64, 0)
        v1 = _basis(64, 1)
        voiceprints.enroll("h1", 0, "王敏", _make_spk_embs(v0))
        voiceprints.enroll("h2", 0, "王敏", _make_spk_embs(v0 + 0.02 * _basis(64, 2)))
        voiceprints.enroll("h3", 0, "李四", _make_spk_embs(v1))

        m = store.create(title="私密复盘会", source="upload")
        mid = m["id"]
        (store.mdir(mid) / "audio.wav").write_bytes(b"RIFF")

        embs = {
            "version": 1,
            "diarizer": "campp",
            "dim": 64,
            "speakers": {
                "0": _make_spk_embs(v0, spk="0")["speakers"]["0"],
                "1": _make_spk_embs(v1, spk="1")["speakers"]["1"],
                "2": _make_spk_embs(v0 + 0.03 * _basis(64, 5), spk="2")["speakers"]["2"],
            },
        }

        def fake_transcribe(wav, num_spk, hotword, vad_kw):
            app.engine.last_info = {"engine": "nano", "diarizer": "campp"}
            app.engine.last_spk_embs = embs
            return [
                {"spk": 0, "start": 0, "end": 3000, "text": "大家好"},
                {"spk": 1, "start": 3000, "end": 6000, "text": "收到"},
                {"spk": 2, "start": 6000, "end": 9000, "text": "继续"},
            ]

        orig_ready = app.engine.ready
        try:
            app.engine.ready = True
            with mock.patch.object(app, "duration_of", return_value=25.0), \
                 mock.patch.object(app, "make_mp3"), \
                 mock.patch.object(app.engine, "transcribe", side_effect=fake_transcribe), \
                 mock.patch.object(app.minutes_jobs, "submit"):
                # 第一轮（非隐私）：产出完整 speaker_meta（auto / suggest / merge_hints）
                app.run_transcribe(mid)
                meta_pub = store.get(mid)
                assert meta_pub.get("speaker_meta")
                assert "0" in meta_pub["speaker_meta"]["auto"]
                assert "1" in meta_pub["speaker_meta"]["suggest"]
                assert len(meta_pub["speaker_meta"]["merge_hints"]) == 1

                # 仅切换 rsi_exclude=True（旧 speaker_meta 仍含 auto/suggest/merge_hints）后重新转写：
                # 必须彻底清除旧 speaker_meta，且不再为未命名说话人自动认人
                app.patch_meeting(mid, {"rsi_exclude": True})
                assert store.get(mid).get("speaker_meta")
                store.update(mid, status="queued")
                app.run_transcribe(mid)
        finally:
            app.engine.ready = orig_ready

        meta_priv = store.get(mid)
        assert meta_priv["rsi_exclude"] is True
        assert "speaker_meta" not in meta_priv
        assert "1" not in (meta_priv.get("speakers") or {})
        assert "2" not in (meta_priv.get("speakers") or {})


if __name__ == "__main__":
    for _name, _fn in list(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            _fn()
            print("ok  ", _name)
    print("全部通过")
