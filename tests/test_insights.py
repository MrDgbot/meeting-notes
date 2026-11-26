"""测试 insights.py、未知声纹聚类批量认人、承诺雷达、项目脉络、全局闪问与周报接口（完全隔离临时目录）。"""
from __future__ import annotations

import asyncio
import json
import math
import shutil
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app as app_mod  # noqa: E402
import insights  # noqa: E402
import llm  # noqa: E402
import relations  # noqa: E402
import store  # noqa: E402
import voiceprints  # noqa: E402


@contextmanager
def _isolated():
    tmp = Path(tempfile.mkdtemp(prefix="mn-insights-"))
    old_data, old_m, old_settings, old_daily = store.DATA, store.MEETINGS, store.SETTINGS, app_mod.DAILY
    store.DATA = tmp
    store.MEETINGS = tmp / "meetings"
    store.SETTINGS = tmp / "settings.json"
    app_mod.DAILY = tmp / "daily"
    store.MEETINGS.mkdir(parents=True, exist_ok=True)
    with store.locked():
        store._meta_cache.clear()
    with relations._lock:
        relations._profile_cache.clear()
    try:
        yield tmp
    finally:
        store.DATA = old_data
        store.MEETINGS = old_m
        store.SETTINGS = old_settings
        app_mod.DAILY = old_daily
        with store.locked():
            store._meta_cache.clear()
        with relations._lock:
            relations._profile_cache.clear()
        shutil.rmtree(tmp, ignore_errors=True)


def _unit(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [round(v / n, 6) for v in vec]


def _seed_meeting(
    mid: str,
    *,
    title: str = "自动记录 14:00",
    title_auto: bool = True,
    created: str | None = None,
    source: str = "ambient",
    status: str = "ready",
    duration: float = 240.0,
    speakers: dict | None = None,
    paragraphs: list[dict] | None = None,
    spk_embs: dict | None = None,
    minutes_md: str = "",
) -> None:
    d = store.MEETINGS / mid
    d.mkdir(parents=True, exist_ok=True)
    ts = created or datetime.now().isoformat(timespec="seconds")
    meta = {
        "id": mid,
        "title": title,
        "title_auto": title_auto,
        "created": ts,
        "status": status,
        "source": source,
        "duration": duration,
        "speech_s": duration,
        "num_spk": 0,
        "hotword": "",
        "template": "general",
        "speakers": speakers or {},
        "error": "",
    }
    store.write_json(d / "meta.json", meta)
    if paragraphs is not None:
        store.write_json(d / "transcript.json", {"asr": "doubao", "cost": 1.2, "paragraphs": paragraphs})
    if spk_embs is not None:
        store.write_json(d / "spk_embs.json", spk_embs)
    if minutes_md:
        store.write_json(d / "minutes.json", {"markdown": minutes_md, "created": ts})


def test_brief_auto_title_preserves_manual_title_and_extracts_commitments():
    with _isolated():
        today_iso = datetime.now().strftime("%Y-%m-%dT10:15:00")
        old_iso = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%dT11:00:00")
        _seed_meeting(
            "20261124-101500-brf1",
            title="自动记录 10:15",
            title_auto=True,
            created=today_iso,
            speakers={"0": "说话人1", "1": "说话人2"},
            paragraphs=[
                {
                    "start": 1000,
                    "end": 9000,
                    "spk": 0,
                    "text": "我们今天把 Workday 单点登录的权限范围先对齐一下，我明天把联调测试方案发给你。",
                },
                {
                    "start": 10000,
                    "end": 18000,
                    "spk": 1,
                    "text": "好的，请你周五前也帮看一下历史权限表有没有漏项。",
                },
            ],
        )
        _seed_meeting(
            "20261119-110000-brf2",
            title="人工已命名会议",
            title_auto=False,
            created=old_iso,
            paragraphs=[
                {"start": 0, "end": 8000, "spk": 0, "text": "我这边今天下班前整理好客户反馈文档。"},
            ],
        )

        # 1) 无 LLM 时本机兜底可提取 title/brief/tags/commitments，并仅更新 title_auto=True
        res1 = asyncio.run(insights.generate_brief("20261124-101500-brf1", None))
        assert res1["mode"] == "local"
        m1 = store.get("20261124-101500-brf1")
        assert m1["title"] != "自动记录 10:15"
        assert m1["title_auto"] is False
        assert m1["brief"]
        assert len(m1.get("tags") or []) >= 1

        res2 = asyncio.run(insights.generate_brief("20261119-110000-brf2", None))
        assert res2["mode"] == "local"
        m2 = store.get("20261119-110000-brf2")
        assert m2["title"] == "人工已命名会议"

        # 2) 承诺雷达可聚合“我承诺的 / 对方答应的”与过期标记
        radar = insights.list_commitments(status="open", days=14)
        assert radar["counts"]["open"] >= 2
        assert radar["counts"]["mine"] >= 1
        assert radar["counts"]["theirs"] >= 1
        assert any(c["overdue"] for c in radar["items"] if c["mid"] == "20261119-110000-brf2")

        # 3) 完成 / 忽略持久化
        first_id = radar["items"][0]["id"]
        first_mid = radar["items"][0]["mid"]
        toggled = insights.toggle_commitment(first_mid, first_id, True)
        assert toggled and toggled["done"] is True
        after_done = insights.list_commitments(status="open", days=14)
        assert not any(c["id"] == first_id for c in after_done["items"])

        dismiss_target = after_done["items"][0]
        assert insights.dismiss_commitment(dismiss_target["mid"], dismiss_target["id"]) is True
        after_dis = insights.list_commitments(status="all", days=14)
        assert not any(c["id"] == dismiss_target["id"] for c in after_dis["items"])


def test_brief_llm_json_parsing_and_preservation_on_remine():
    with _isolated():
        _seed_meeting(
            "20261124-110000-llm1",
            title="自动记录 11:00",
            title_auto=True,
            paragraphs=[{"start": 2000, "end": 7000, "spk": 0, "text": "我今天下午把报价单发你。"}],
        )

        async def fake_chat(prov, msgs, **kw):
            return '```json\n{"title":"Q4报价单与交付节奏","brief":"确定今天下午发出新版报价单并对齐交付周期","tags":["报价单","Q4交付"],"commitments":[{"who":"我","direction":"mine","text":"下午发出新版报价单","due_hint":"今天下午","ts":"00:02"}]}\n```'

        orig_chat = llm.chat
        llm.chat = fake_chat
        try:
            res = asyncio.run(
                insights.generate_brief(
                    "20261124-110000-llm1",
                    {"name": "mock", "model": "m", "base_url": "https://example.com/v1", "api_key": "k"},
                )
            )
        finally:
            llm.chat = orig_chat

        assert res["mode"] == "llm"
        meta = store.get("20261124-110000-llm1")
        assert meta["title"] == "Q4报价单与交付节奏"
        assert "报价单" in meta["brief"]
        assert meta["tags"] == ["报价单", "Q4交付"]


def test_voiceprint_cluster_and_batch_name():
    with _isolated():
        now = datetime.now()
        v_colleague = _unit([1.0, 0.2, 0.0, 0.0])
        v_other = _unit([0.0, 0.1, 1.0, 0.0])

        _seed_meeting(
            "20261124-090000-vp1",
            title="早会沟通",
            created=(now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S"),
            paragraphs=[
                {"start": 1000, "end": 7000, "spk": 0, "text": "昨天把权限表的边界重新梳理了一遍，基本没有遗漏。"},
                {"start": 8000, "end": 12000, "spk": 1, "text": "收到，我下午拉一下研发测试同步。"},
            ],
            spk_embs={
                "version": 1,
                "speakers": {
                    "0": {"centroid": v_colleague, "n_chunks": 24, "voiced_s": 42.0, "intra_cos_mean": 0.72},
                    "1": {"centroid": v_other, "n_chunks": 18, "voiced_s": 30.0, "intra_cos_mean": 0.68},
                },
            },
        )
        _seed_meeting(
            "20261124-130000-vp2",
            title="午后讨论",
            created=(now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
            paragraphs=[
                {"start": 500, "end": 6500, "spk": 1, "text": "刚才客户端测试环境已经部署好了，可以开始联调。"},
            ],
            spk_embs={
                "version": 1,
                "speakers": {
                    "1": {"centroid": _unit([0.99, 0.21, 0.02, 0.0]), "n_chunks": 20, "voiced_s": 35.0, "intra_cos_mean": 0.75},
                },
            },
        )

        # 未开启隐私排除的两场应聚出一个至少含 2 场、带原声样本的常客簇
        cl_resp = voiceprints.cluster_unnamed_speakers(days=14)
        clusters = cl_resp["clusters"]
        assert len(clusters) >= 1
        top = clusters[0]
        assert top["meeting_count"] == 2
        assert len(top["samples"]) >= 2

        # 一键批量命名：两场 meta.speakers 更新 + voiceprints.json 建档
        batch_res = voiceprints.batch_name_cluster("林工", top["members"])
        assert batch_res["updated_meetings"] == 2
        assert batch_res["enrolled"] == 2
        assert store.get("20261124-090000-vp1")["speakers"]["0"] == "林工"
        assert store.get("20261124-130000-vp2")["speakers"]["1"] == "林工"
        vp_sum = voiceprints.summary()
        assert any(p["name"] == "林工" and p["sessions"] == 2 for p in vp_sum["persons"])


def test_projects_global_ask_weekly_and_api_endpoints():
    with _isolated():
        today = datetime.now()
        d_today = today.strftime("%Y-%m-%d")
        d_prev = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        # 若今天恰为周一，昨天是上周；仍保留至少两场同一天或本周内会议确保 weekly 与 projects 同时命中
        d_same_week_2 = today.strftime("%Y-%m-%d")

        _seed_meeting(
            f"{d_today.replace('-', '')}-100000-p1",
            title="Workday 单点登录一期评审",
            created=f"{d_today}T10:00:00",
            speakers={"0": "张伟"},
            paragraphs=[
                {"start": 0, "end": 6000, "spk": 0, "text": "Workday 一期目标是下周三前打通 SAML 单点登录和角色同步。"},
                {"start": 7000, "end": 12000, "spk": 0, "text": "我明天把测试账号清单整理完发给你。"},
            ],
            minutes_md="## 待办\n- [x] 张伟 申请 SAML 测试证书 [00:00]\n- [ ] 张伟 输出权限矩阵 [00:07]\n",
        )
        _seed_meeting(
            f"{d_same_week_2.replace('-', '')}-150000-p2",
            title="Workday 权限矩阵跟进",
            created=f"{d_same_week_2}T15:00:00",
            speakers={"0": "张伟", "1": "李四"},
            paragraphs=[
                {"start": 0, "end": 5000, "spk": 1, "text": "Workday 的角色权限矩阵已经覆盖了财务和研发两个部门。"},
            ],
        )

        # 生成一天日报以测试周报汇总
        daily_dir = store.DATA / "daily"
        daily_dir.mkdir(parents=True, exist_ok=True)
        store.write_json(
            daily_dir / f"{d_prev}.json",
            {"markdown": "## 重点\n完成 Workday 接口预研。", "created": f"{d_prev}T21:30:00"},
        )

        client = TestClient(app_mod.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
        hdrs = {"origin": "http://127.0.0.1"}

        # 1) 项目脉络接口
        pr = client.get("/api/projects?days=30")
        assert pr.status_code == 200
        projects = pr.json()["projects"]
        assert any("workday" in p["name"].lower() and p["meeting_count"] == 2 for p in projects)

        # 2) 全局闪问接口（无 key 走智能检索 + 引用跳转）
        qr = client.post("/api/ask-global", json={"q": "Workday 一期目标是什么"}, headers=hdrs)
        assert qr.status_code == 200
        qbody = qr.json()
        assert qbody["mode"] == "search"
        assert len(qbody["citations"]) >= 1
        assert "SAML" in qbody["citations"][0]["quote"]

        # 3) 隐私会议排除在全局闪问之外
        store.update(f"{d_same_week_2.replace('-', '')}-150000-p2", rsi_exclude=True)
        qr2 = client.post("/api/ask-global", json={"q": "财务和研发两个部门"}, headers=hdrs)
        assert qr2.status_code == 200
        assert not qr2.json()["citations"]

        # 4) 承诺雷达接口 + 补全摘要接口 + 周报接口
        cr = client.get("/api/commitments?status=open&days=14")
        assert cr.status_code == 200
        citems = cr.json()["items"]
        assert len(citems) >= 1
        tr = client.post(
            "/api/commitments/toggle",
            json={"mid": citems[0]["mid"], "id": citems[0]["id"], "done": True},
            headers=hdrs,
        )
        assert tr.status_code == 200 and tr.json()["done"] is True

        bf = client.post("/api/insights/backfill", json={"limit": 5}, headers=hdrs)
        assert bf.status_code == 200 and bf.json()["count"] >= 1
        assert store.get(f"{d_today.replace('-', '')}-100000-p1")["brief"]

        br = client.post(f"/api/meetings/{d_today.replace('-', '')}-100000-p1/brief", json={}, headers=hdrs)
        assert br.status_code == 200
        assert br.json()["meta"]["brief"]

        wr = client.post("/api/weekly/draft", json={"end": d_today}, headers=hdrs)
        assert wr.status_code == 200
        rep = wr.json()["report"]
        assert "Workday" in rep["markdown"]
        assert "本周概览" in rep["markdown"]

        wg = client.get(f"/api/weekly?end={d_today}")
        assert wg.status_code == 200
        assert wg.json()["report"]["markdown"] == rep["markdown"]
        assert wg.json()["meeting_count"] == 2


def test_quick_ask_suggestions_llm_cache_refresh_and_local_fallback():
    with _isolated():
        today = datetime.now().strftime("%Y-%m-%d")
        # 1) 空工作区返回默认 local 推荐
        empty_res = asyncio.run(insights.quick_ask_suggestions(None))
        assert empty_res["mode"] == "local"
        assert empty_res["suggestions"] == insights.DEFAULT_QUICK_ASK_SUGGESTIONS

        # 2) 写入会议与隐私排除会议
        _seed_meeting(
            f"{today.replace('-', '')}-100000-sg1",
            title="Apollo 计费改造评审",
            created=f"{today}T10:00:00",
            speakers={"0": "陈总", "1": "王工"},
            paragraphs=[
                {"start": 0, "end": 5000, "spk": 0, "text": "Apollo 计费月底前切流，请王工确认账单幂等。"},
            ],
        )
        _seed_meeting(
            f"{today.replace('-', '')}-110000-sg2",
            title="Apollo 灰度方案同步",
            created=f"{today}T11:00:00",
            speakers={"0": "王工"},
            paragraphs=[
                {"start": 0, "end": 5000, "spk": 0, "text": "我明天把 Apollo 灰度回滚预案发给大家。"},
            ],
        )
        _seed_meeting(
            f"{today.replace('-', '')}-120000-sg3",
            title="绝密薪酬复盘",
            created=f"{today}T12:00:00",
            paragraphs=[{"start": 0, "end": 4000, "spk": 0, "text": "绝密薪酬调整不要入学习。"}],
        )
        store.update(f"{today.replace('-', '')}-120000-sg3", rsi_exclude=True)

        calls = 0
        seen_prompts: list[str] = []

        async def fake_chat(prov, msgs, **kw):
            nonlocal calls
            calls += 1
            seen_prompts.append(msgs[-1]["content"])
            if calls == 1:
                return '```json\n["Apollo 计费切流和回滚方案", "王工负责的账单幂等进度", "近期 Apollo 评审遗留风险"]\n```'
            return '["Apollo 灰度发布时间节点", "陈总对计费改造的核心要求", "Apollo 待确认的账单边界"]'

        prov = {"name": "mock", "model": "deepseek-chat", "base_url": "https://example.com/v1", "api_key": "k"}
        orig_chat = llm.chat
        llm.chat = fake_chat
        try:
            r1 = asyncio.run(insights.quick_ask_suggestions(prov))
            assert r1["mode"] == "llm"
            assert r1["cached"] is False
            assert len(r1["suggestions"]) == 3
            assert calls == 1
            assert "绝密薪酬" not in seen_prompts[0]
            assert "Apollo" in seen_prompts[0]

            # 相同指纹与模型应命中磁盘缓存
            r2 = asyncio.run(insights.quick_ask_suggestions(prov))
            assert r2["mode"] == "llm"
            assert r2["cached"] is True
            assert r2["suggestions"] == r1["suggestions"]
            assert calls == 1

            # refresh=True 跳过缓存并带入上一批问题提示词
            r3 = asyncio.run(insights.quick_ask_suggestions(prov, refresh=True))
            assert r3["mode"] == "llm"
            assert r3["cached"] is False
            assert calls == 2
            assert "Apollo 计费切流和回滚方案" in seen_prompts[1]

            # HTTP 接口校验（命中缓存）
            client = TestClient(app_mod.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
            resp = client.get("/api/ask-global/suggestions")
            assert resp.status_code == 200
            assert len(resp.json()["suggestions"]) == 3
        finally:
            llm.chat = orig_chat

        # 3) LLM 异常或未配置时降级为基于用户数据的 local 推荐
        async def fail_chat(prov, msgs, **kw):
            raise RuntimeError("boom")

        llm.chat = fail_chat
        try:
            r_err = asyncio.run(insights.quick_ask_suggestions(prov, refresh=True))
            assert r_err["mode"] == "local"
            assert r_err["cached"] is False
            assert any("Apollo" in q for q in r_err["suggestions"])
        finally:
            llm.chat = orig_chat

        r_noprov = asyncio.run(insights.quick_ask_suggestions(None, refresh=True))
        assert r_noprov["mode"] == "local"
        assert any("Apollo" in q for q in r_noprov["suggestions"])
