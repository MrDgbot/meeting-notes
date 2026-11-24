"""Unit 1 UX & smart-default tests: trash/restore, commitment/QA undo, notes.md relations,
generic upload auto-title, unsaved provider test, LAN auto-PIN, and friendly LLM error mapping.
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-ux-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app  # noqa: E402
import insights  # noqa: E402
import lan  # noqa: E402
import llm  # noqa: E402
import relations  # noqa: E402
import store  # noqa: E402
import voiceprints  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def test_trash_and_restore_preserves_discarded_separation():
    m = store.create("重要设计讨论", status="ready", source="mic")
    mid = m["id"]
    store.save(mid, "transcript.json", {"paragraphs": [{"start": 0, "end": 2000, "spk": 0, "text": "周三发版"}]})

    res = app.trash_meeting_api(mid)
    assert res["ok"] is True
    assert not store.mdir(mid).exists()
    assert not (store.DISCARDED / mid).exists(), "用户删除到回收站不得进入 ambient discarded 目录"
    trashed = app.list_trash_api()["items"]
    assert any(x["id"] == mid for x in trashed)

    restored = app.restore_trash_api(mid)
    assert restored["ok"] is True
    assert store.mdir(mid).exists()
    assert all(x["id"] != mid for x in app.list_trash_api()["items"])

    app.trash_meeting_api(mid)
    purged = app.purge_trash_api(mid)
    assert purged["ok"] is True
    assert all(x["id"] != mid for x in app.list_trash_api()["items"])


def test_mark_delete_and_qa_restore():
    m = store.create("打点与问答撤销", status="ready", source="mic")
    mid = m["id"]
    added = app.add_mark(mid, {"t_ms": 12000, "label": "重点"})
    mark_id = added["mark"]["id"]
    del_res = app.delete_mark(mid, mark_id)
    assert del_res["marks"] == []
    assert del_res["deleted"]["t_ms"] == 12000

    store.save(mid, "qa.json", [{"q": "谁负责？", "a": "张三 [00:12]", "t": "2026-11-24T10:00:00"}])
    clr = app.clear_qa(mid)
    assert clr["ok"] and len(clr["cleared"]) == 1
    assert app.get_meeting(mid)["qa"] == []

    rst = app.restore_qa(mid, {"items": clr["cleared"]})
    assert rst["ok"] and len(rst["qa"]) == 1
    assert app.get_meeting(mid)["qa"][0]["q"] == "谁负责？"


def test_commitment_dismiss_and_restore():
    m = store.create("承诺恢复测试", status="ready", source="mic")
    mid = m["id"]
    insights.save_commitments(
        mid,
        [
            {
                "id": "c1",
                "mid": mid,
                "who": "我",
                "direction": "mine",
                "text": "明天发测试报告",
                "ts": "00:10",
                "start_ms": 10000,
                "done": False,
                "dismissed": False,
            }
        ],
    )
    assert len(insights.list_commitments()["items"]) >= 1
    app.dismiss_commitment_api({"mid": mid, "id": "c1"})
    assert all(x["id"] != "c1" for x in insights.list_commitments()["items"])
    app.restore_commitment_api({"mid": mid, "id": "c1"})
    assert any(x["id"] == "c1" for x in insights.list_commitments()["items"])


def test_relations_reads_notes_md():
    m1 = store.create("会议A", status="ready", source="mic")
    m2 = store.create("会议B", status="ready", source="mic")
    store.write_text(store.mdir(m1["id"]) / "notes.md", "ApolloEngine Gateway 上线排期与灰度观察")
    store.write_text(store.mdir(m2["id"]) / "notes.md", "ApolloEngine Gateway 压测通过，确认灰度")
    rel = relations.related_meetings(m1["id"])
    assert any(r["id"] == m2["id"] and "ApolloEngine" in r["shared_terms"] for r in rel), rel


def test_generic_upload_names_and_local_brief_title_auto():
    assert store.is_generic_upload_name("2026-11-24_10-00")
    assert store.is_generic_upload_name("IMG_1234")
    assert store.is_generic_upload_name("录音 3")
    assert not store.is_generic_upload_name("Q4季度规划会")

    m = store.create("", source="ambient", status="ready")
    assert m["title_auto"] is True
    res = insights.apply_brief_to_meeting(
        m["id"],
        {"title": "临时草拟标题", "brief": "一句摘要", "tags": ["规划"], "commitments": []},
        lock_title=False,
    )
    assert res["meta"]["title"] == "临时草拟标题"
    assert res["meta"]["title_auto"] is False
    assert res["meta"]["title_source"] == "local_brief"

    app._save_minutes(m["id"], {"markdown": "# AI 升级标题\n\n正文内容"})
    assert store.get(m["id"])["title"] == "AI 升级标题"


def test_friendly_llm_errors_and_draft_provider_test():
    msg401 = llm._friendly_http_error(401, '{"error":{"message":"Incorrect API key"}}', "DeepSeek")
    assert "API Key" in msg401 and "Incorrect API key" not in msg401

    msg429 = llm._friendly_http_error(429, "rate limit", "通义")
    assert "限流" in msg429 or "频繁" in msg429

    async def fake_chat(p, msgs, **kw):
        assert p["base_url"] == "http://127.0.0.1:9999/v1"
        assert p["model"] == "draft-model"
        return "你好"

    with mock.patch.object(app, "chat", fake_chat):
        out = asyncio.run(
            app.test_provider({"base_url": "http://127.0.0.1:9999/v1", "model": "draft-model", "api_key": "k"})
        )
    assert out["ok"] is True and out["reply"] == "你好"


def test_lan_auto_generates_pin_when_enabled_without_password():
    saved = (lan.DIR, lan.CFG, lan.CA_KEY, lan.CA_PEM, lan.SRV_KEY, lan.SRV_PEM, lan._cfg)
    root = Path(tempfile.mkdtemp(prefix="mn-lan-pin-"))
    try:
        lan.DIR = root / "lan"
        lan.CFG = lan.DIR / "config.json"
        lan.CA_KEY, lan.CA_PEM, lan.SRV_KEY, lan.SRV_PEM = (lan.DIR / n for n in ("ca.key", "ca.pem", "server.key", "server.pem"))
        lan._cfg = None
        req = mock.MagicMock()
        req.scope = {"type": "http", "client": ("127.0.0.1", 1234)}
        with mock.patch.object(lan.server, "apply", mock.AsyncMock()):
            res = asyncio.run(lan.put_lan(req, {"enabled": True}))
        assert res.get("has_password") is True
        assert res.get("generated_password") and len(res["generated_password"]) == 6
    finally:
        lan.DIR, lan.CFG, lan.CA_KEY, lan.CA_PEM, lan.SRV_KEY, lan.SRV_PEM, lan._cfg = saved
        import shutil
        shutil.rmtree(root, ignore_errors=True)


def test_manual_rename_preserved_across_brief_and_minutes():
    m = store.create("", status="ready", source="mic")
    mid = m["id"]
    insights.apply_brief_to_meeting(mid, {"title": "系统本地摘要标题"}, lock_title=False)
    assert store.get(mid)["title"] == "系统本地摘要标题"
    assert store.get(mid)["title_source"] == "local_brief"

    app.patch_meeting(mid, {"title": "我的专属标题"})
    meta = store.get(mid)
    assert meta["title"] == "我的专属标题"
    assert meta["title_source"] == "manual"

    insights.apply_brief_to_meeting(mid, {"title": "AI自动标题"}, lock_title=True)
    assert store.get(mid)["title"] == "我的专属标题"

    app._save_minutes(mid, {"markdown": "# AI生成纪要标题\n正文"})
    assert store.get(mid)["title"] == "我的专属标题"

    m2 = store.create("", status="ready", source="mic")
    insights.apply_brief_to_meeting(m2["id"], {"title": "临时本地标题"}, lock_title=False)
    app._save_minutes(m2["id"], {"markdown": "# AI生成纪要标题\n正文"})
    assert store.get(m2["id"])["title"] == "AI生成纪要标题"


def test_restore_qa_merges_newer_entries_without_duplicates():
    m = store.create("问答合并恢复", status="ready", source="mic")
    mid = m["id"]
    store.save(
        mid,
        "qa.json",
        [
            {"q": "旧问题1", "a": "旧回答1", "t": "00:10"},
            {"q": "共同问题", "a": "共同回答", "t": "00:20"},
        ],
    )
    clr = app.clear_qa(mid)
    assert app.get_meeting(mid)["qa"] == []

    store.save(
        mid,
        "qa.json",
        [
            {"q": "共同问题", "a": "共同回答", "t": "00:20"},
            {"q": "新问题2", "a": "新回答2", "t": "00:30", "extra": 1},
        ],
    )
    rst = app.restore_qa(mid, {"items": clr["cleared"]})
    assert rst["ok"] is True
    assert [x["q"] for x in rst["qa"]] == ["旧问题1", "共同问题", "新问题2"]
    assert rst["qa"][2]["extra"] == 1


def test_provider_draft_parses_extra_body_and_respects_keep_key_false():
    captured: list[dict] = []

    async def fake_chat(prov, messages, max_tokens=256):
        captured.append(dict(prov))
        return "你好"

    saved_prov = {
        "id": "p1",
        "name": "Saved",
        "base_url": "https://saved.example/v1",
        "api_key": "saved-secret",
        "model": "saved-m",
        "extra_body": {"saved_flag": 1},
    }
    with mock.patch.object(app, "_active_prov_optional", return_value=saved_prov), mock.patch.object(
        app, "chat", fake_chat
    ):
        res = asyncio.run(
            app.test_provider(
                {
                    "id": "p1",
                    "base_url": "https://draft.example/v1",
                    "model": "draft-m",
                    "keep_key": False,
                    "extra_body": '{"thinking": {"type": "disabled"}}',
                }
            )
        )
        assert res["ok"] is True
        assert captured[0]["api_key"] == ""
        assert captured[0]["extra_body"] == {"thinking": {"type": "disabled"}}

        try:
            asyncio.run(
                app.test_provider(
                    {
                        "id": "p1",
                        "base_url": "https://draft.example/v1",
                        "model": "draft-m",
                        "extra_body": "{not-valid-json",
                    }
                )
            )
            raise AssertionError("预期非法 extra_body 应抛出 400")
        except HTTPException as exc:
            assert exc.status_code == 400


def _seed_spk_meeting(title: str, spk_name: str, centroid: list[float], md_text: str = "") -> str:
    m = store.create(title, status="ready", source="mic", speakers={"0": spk_name})
    mid = m["id"]
    store.save(
        mid,
        "transcript.json",
        {"paragraphs": [{"start": 0, "end": 20000, "spk": 0, "text": f"{spk_name} 负责推进这件事"}]},
    )
    embs = {
        "diarizer": "campp",
        "dim": len(centroid),
        "speakers": {"0": {"centroid": centroid, "voiced_s": 25.0, "n_chunks": 12, "intra_cos_mean": 0.9}},
    }
    store.save(mid, "spk_embs.json", embs)
    if md_text:
        store.save(mid, "minutes.json", {"markdown": md_text})
    voiceprints.enroll(mid, "0", spk_name, embs)
    return mid


def test_rename_and_merge_person_updates_meetings_voiceprints_minutes_and_commitments():
    voiceprints.reset()
    mid1 = _seed_spk_meeting("周会A", "张山_测试", [1.0, 0.0, 0.0, 0.0], "## 纪要\n- 张山_测试 提交方案\n")
    mid2 = _seed_spk_meeting("周会B", "张三_测试", [0.98, 0.19, 0.0, 0.0])
    insights.save_commitments(
        mid1,
        [
            {
                "id": "c-r1",
                "mid": mid1,
                "who": "张山_测试",
                "direction": "theirs",
                "text": "张山提交方案",
                "ts": "00:05",
                "start_ms": 5000,
            }
        ],
    )

    res = app.rename_person_api({"old_name": "张山_测试", "new_name": "张三_测试", "update_minutes": True})
    assert res["ok"] is True
    assert res["merged"] is True
    assert res["meetings_updated"] == 1
    assert res["minutes_updated"] == 1
    assert res["voiceprint_sessions"] == 2
    assert store.get(mid1)["speakers"]["0"] == "张三_测试"
    assert "张三_测试 提交方案" in (store.load(mid1, "minutes.json") or {})["markdown"]
    assert (insights.load_commitments(mid1) or [])[0]["who"] == "张三_测试"
    assert voiceprints.person_session_count("张山_测试") == 0
    assert voiceprints.person_session_count("张三_测试") == 2
    tl = app.get_person_timeline("张三_测试")
    assert tl["total_meetings"] == 2
    assert tl["voiceprint_sessions"] == 2
    assert {m["id"] for m in tl["meetings"]} == {mid1, mid2}


def test_reassign_person_single_meeting_and_anonymous_revokes_voiceprint():
    voiceprints.reset()
    mid_keep = _seed_spk_meeting("评审1", "李四_测试", [0.0, 1.0, 0.0, 0.0])
    mid_fix = _seed_spk_meeting("评审2", "李四_测试", [0.0, 0.0, 1.0, 0.0], "## 纪要\n- 李四_测试 确认排期\n")

    res = app.reassign_person_meeting_api(
        {"mid": mid_fix, "old_name": "李四_测试", "new_name": "王五_测试", "update_minutes": True}
    )
    assert res["ok"] is True
    assert store.get(mid_fix)["speakers"]["0"] == "王五_测试"
    assert store.get(mid_keep)["speakers"]["0"] == "李四_测试"
    assert "王五_测试 确认排期" in (store.load(mid_fix, "minutes.json") or {})["markdown"]
    assert voiceprints.person_session_count("李四_测试") == 1
    assert voiceprints.person_session_count("王五_测试") == 1

    clr = app.reassign_person_meeting_api({"mid": mid_fix, "old_name": "王五_测试", "new_name": ""})
    assert clr["ok"] is True
    assert store.get(mid_fix)["speakers"]["0"] == ""
    assert voiceprints.person_session_count("王五_测试") == 0


def test_clear_person_resets_meetings_and_deletes_voiceprint():
    voiceprints.reset()
    mid = _seed_spk_meeting("复盘会", "误识别人", [0.0, 0.0, 0.0, 1.0])
    res = app.clear_person_api({"name": "误识别人"})
    assert res["ok"] is True
    assert res["meetings_updated"] == 1
    assert res["voiceprint_deleted"] is True
    assert store.get(mid)["speakers"]["0"] == ""
    assert voiceprints.person_session_count("误识别人") == 0
    assert "负责推进这件事" in store.load(mid, "transcript.json")["paragraphs"][0]["text"]
