"""测试跨会议关联引擎（relations.py）、REST API 与本机 stdio MCP Server（mcp_server.py）。"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
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
import mcp_server  # noqa: E402
import relations  # noqa: E402
import store  # noqa: E402


@contextmanager
def _isolated():
    tmp = Path(tempfile.mkdtemp(prefix="mn-rel-"))
    old_data, old_m = store.DATA, store.MEETINGS
    store.DATA = tmp
    store.MEETINGS = tmp / "meetings"
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
        with store.locked():
            store._meta_cache.clear()
        with relations._lock:
            relations._profile_cache.clear()
        shutil.rmtree(tmp, ignore_errors=True)


def _seed_meeting(
    title: str,
    *,
    speakers: dict[str, str] | None = None,
    paragraphs: list[dict] | None = None,
    minutes_md: str = "",
    hotword: str = "",
    brief: str = "",
    tags: list[str] | None = None,
    created: str | None = None,
    rsi_exclude: bool = False,
) -> str:
    meta = store.create(title=title, hotword=hotword)
    mid = meta["id"]
    patch: dict = {"status": "ready", "duration": 600.0}
    if speakers:
        patch["speakers"] = speakers
    if brief:
        patch["brief"] = brief
    if tags:
        patch["tags"] = tags
    if created:
        patch["created"] = created
    if rsi_exclude:
        patch["rsi_exclude"] = True
    store.update(mid, **patch)
    if paragraphs:
        store.save(mid, "transcript.json", {"asr": "paraformer", "cost": 1.2, "paragraphs": paragraphs})
    if minutes_md:
        store.save(mid, "minutes.json", {"markdown": minutes_md, "provider": "test", "model": "m", "created": created or meta["created"], "cost": 1.0})
    return mid


def test_related_meetings_and_people_timeline():
    with _isolated():
        m1 = _seed_meeting(
            "Workday 权限评审会",
            speakers={"0": "张三", "1": "李四"},
            paragraphs=[
                {"start": 0, "end": 12000, "spk": 0, "text": "Workday 系统登录权限和单点登录方案需要本周确认。"},
                {"start": 12000, "end": 25000, "spk": 1, "text": "同意，我先和 IT 部门对齐 Workday 接口文档。"},
            ],
            minutes_md="## 待办\n- [ ] 张三 确认 Workday 单点登录方案 [00:00]\n- [x] 李四 整理历史工单\n```md\n- [ ] 代码块里的假待办\n```\n",
        )
        m2 = _seed_meeting(
            "Workday 接口跟进",
            speakers={"0": "张三", "1": "王五"},
            paragraphs=[
                {"start": 0, "end": 18000, "spk": 0, "text": "接着上次 Workday 单点登录的方案，IT 已经给了测试账号。"},
            ],
            minutes_md="## 决议\n继续推进 Workday 联调\n## 待办\n- [ ] 王五 开通测试账号 [00:05]\n",
        )
        _seed_meeting(
            "周末团建聚餐",
            speakers={"0": "赵六"},
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "周六去吃火锅还是烤肉？"}],
        )

        rel = relations.related_meetings(m1, limit=5)
        assert len(rel) >= 1
        assert rel[0]["id"] == m2
        assert "张三" in rel[0]["shared_speakers"]
        assert any("workday" in t.lower() for t in rel[0]["shared_terms"])

        people = relations.list_people()
        names = [p["name"] for p in people]
        assert "张三" in names and "李四" in names
        zs = next(p for p in people if p["name"] == "张三")
        assert zs["meetings"] == 2
        assert zs["open_todos"] == 2

        tl = relations.person_timeline("张三")
        assert tl["total_meetings"] == 2
        assert any(c["name"] == "李四" for c in tl["co_speakers"])
        assert len(tl["todos"]) == 3


def test_todos_api_toggle_and_fenced_code_safety():
    with _isolated():
        m1 = _seed_meeting(
            "产品需求评审",
            speakers={"0": "产品/张三"},
            minutes_md="## 待办\n- [ ] 完成原型评审 [01:20]\n```markdown\n- [ ] 不要改到代码块里的项\n```\n- [x] 输出测试计划\n",
        )
        client = TestClient(app_mod.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
        hdrs = {"origin": "http://127.0.0.1"}

        r = client.get("/api/todos?status=all")
        assert r.status_code == 200
        body = r.json()
        assert body["counts"] == {"open": 1, "done": 1, "total": 2}
        assert body["items"][0]["ts"] == "01:20"

        r2 = client.post("/api/todos/toggle", json={"mid": m1, "idx": 0, "done": True}, headers=hdrs)
        assert r2.status_code == 200
        assert r2.json()["done"] is True

        mn = store.load(m1, "minutes.json")
        assert "- [x] 完成原型评审 [01:20]" in mn["markdown"]
        assert "- [ ] 不要改到代码块里的项" in mn["markdown"]

        rp = client.get("/api/people/%E4%BA%A7%E5%93%81%2F%E5%BC%A0%E4%B8%89")
        assert rp.status_code == 200
        assert rp.json()["total_meetings"] == 1

        assert client.get(f"/api/meetings/{m1}/related").status_code == 200
        rmcp = client.get("/api/mcp/config")
        assert rmcp.status_code == 200
        cfg_body = rmcp.json()
        assert "meeting-notes" in cfg_body["config"]["mcpServers"]
        srv = cfg_body["config"]["mcpServers"]["meeting-notes"]
        assert srv["env"]["MEETING_DATA"] == cfg_body["data_dir"]
        assert cfg_body["data_dir"] == str(store.DATA.resolve())
        assert cfg_body["skill_path"].endswith("skills/meeting-context/SKILL.md")
        assert "install-mcp-skill.mjs" in cfg_body["install_cmd"]
        assert f"--data-dir {cfg_body['data_dir']}" in cfg_body["install_cmd"]
        assert "--targets all" not in cfg_body["install_cmd"]
        assert cfg_body["tools"] == [t["name"] for t in mcp_server.TOOLS]
        assert cfg_body["prompts"] == [p["name"] for p in mcp_server.PROMPTS]
        assert cfg_body["resources"] == [r["uri"] for r in mcp_server.RESOURCES]
        assert len(cfg_body["tools"]) == 11
        assert len(cfg_body["prompts"]) == 4
        assert len(cfg_body["resources"]) == 4


def test_mcp_server_rpc_and_stdio_privacy():
    with _isolated() as tmp:
        today_dt = datetime.now()
        d_today = today_dt.strftime("%Y-%m-%d")
        d_yest = (today_dt - timedelta(days=1)).strftime("%Y-%m-%d")

        m_pub = _seed_meeting(
            "Apollo 计费改造评审",
            speakers={"0": "张三", "1": "李四"},
            brief="确认月底前完成 Apollo 计费切流和账单幂等验证",
            tags=["Apollo", "计费改造"],
            created=f"{d_today}T10:00:00",
            paragraphs=[
                {"start": 1000, "end": 8000, "spk": 0, "text": "本季度核心 OKR 是提升转化率，同时 Apollo 计费月底前切流。"},
                {"start": 15000, "end": 22000, "spk": 0, "text": "我明天把 Apollo 账单幂等测试方案发给你。"},
                {"start": 25000, "end": 32000, "spk": 1, "text": "请你周五前确认一下历史对账脚本。"},
            ],
            minutes_md="## 决议\n月底前完成 Apollo 切流\n## 待办\n- [ ] 张三 拆解 Q3 OKR 指标 [00:01]\n- [x] 李四 备份历史账单\n",
        )
        m_pub2 = _seed_meeting(
            "Apollo 灰度回滚预案同步",
            speakers={"0": "张三", "1": "王五"},
            brief="对齐 Apollo 灰度切换窗口与回滚触发阈值",
            tags=["Apollo", "灰度发布"],
            created=f"{d_today}T14:00:00",
            paragraphs=[
                {"start": 5000, "end": 12000, "spk": 1, "text": "Apollo 灰度预案已经准备好了，监控指标接入完成。"},
            ],
            minutes_md="## 待办\n- [ ] 王五 配置 Apollo 灰度告警 [00:05]\n",
        )
        m_priv = _seed_meeting(
            "私密薪酬讨论",
            speakers={"0": "HR", "1": "张三"},
            brief="绝密薪酬调整方案",
            tags=["绝密薪酬", "Apollo"],
            created=f"{d_today}T16:00:00",
            paragraphs=[
                {"start": 0, "end": 5000, "spk": 0, "text": "绝密薪酬方案与 Apollo 奖金池分配。"},
                {"start": 6000, "end": 11000, "spk": 0, "text": "我明天把绝密薪酬清单发给你。"},
            ],
            minutes_md="## 待办\n- [ ] HR 核对绝密薪酬表 [00:00]\n",
            rsi_exclude=True,
        )
        _seed_meeting(
            "私密薪酬复盘",
            speakers={"0": "HR"},
            brief="绝密薪酬二期复盘",
            tags=["绝密薪酬"],
            created=f"{d_today}T17:00:00",
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "绝密薪酬二期复盘细节。"}],
            rsi_exclude=True,
        )

        # Write saved daily summary for yesterday (so default daily fallback & explicit date can be tested)
        daily_dir = tmp / "daily"
        daily_dir.mkdir(parents=True, exist_ok=True)
        store.write_json(
            daily_dir / f"{d_yest}.json",
            {"markdown": "## 昨日重点\n完成 Apollo 计费压测准备。", "created": f"{d_yest}T21:00:00"},
        )
        store.write_json(
            daily_dir / f"{d_today}.json",
            {
                "markdown": "## 今日重点\n推进 Apollo 切流与灰度预案。",
                "created": f"{d_today}T20:00:00",
                "meetings": [m_pub, m_pub2],
            },
        )

        # 1) initialize & capability contract (v2.0.0)
        init_r = mcp_server.handle_rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        assert init_r["result"]["serverInfo"] == {"name": "meeting-notes", "version": "2.0.0"}
        assert init_r["result"]["capabilities"] == {"tools": {}, "prompts": {}, "resources": {}}

        tools_r = mcp_server.handle_rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tool_names = [t["name"] for t in tools_r["result"]["tools"]]
        assert tool_names == [
            "list_meetings",
            "search_meetings",
            "get_meeting",
            "get_related_meetings",
            "get_person_history",
            "list_todos",
            "build_context_pack",
            "list_projects",
            "list_commitments",
            "get_daily_summary",
            "get_weekly_digest",
        ]

        # 2) Backwards-compatible tools + upgraded search_meetings + privacy
        list_res = mcp_server.handle_tool_call("list_meetings", {"limit": 10}, exclude_private=True)
        assert list_res["count"] == 2
        assert all(m["id"] != m_priv for m in list_res["meetings"])

        search_priv = mcp_server.handle_tool_call("search_meetings", {"query": "绝密"}, exclude_private=True)
        assert search_priv["count"] == 0
        search_pub = mcp_server.handle_tool_call("search_meetings", {"query": "OKR"}, exclude_private=True)
        assert search_pub["count"] == 1 and search_pub["hits"][0]["id"] == m_pub
        # Tokenized multi-word query via insights.retrieve_global_context scoring
        search_tok = mcp_server.handle_tool_call("search_meetings", {"query": "Apollo 计费切流方案"}, exclude_private=True)
        assert search_tok["count"] >= 1
        assert all(h["id"] != m_priv for h in search_tok["hits"])
        assert any(h["id"] == m_pub for h in search_tok["hits"])

        gm = mcp_server.handle_tool_call("get_meeting", {"mid": m_pub, "include_transcript": True}, exclude_private=True)
        assert gm["meta"]["id"] == m_pub and "Apollo" in gm["transcript"]
        try:
            mcp_server.handle_tool_call("get_meeting", {"mid": m_priv}, exclude_private=True)
            raise AssertionError("private meeting should be blocked")
        except ValueError:
            pass

        rel_res = mcp_server.handle_tool_call("get_related_meetings", {"mid": m_pub, "limit": 5}, exclude_private=True)
        assert any(x["id"] == m_pub2 for x in rel_res["items"])
        assert all(x["id"] != m_priv for x in rel_res["items"])

        people_res = mcp_server.handle_tool_call("get_person_history", {}, exclude_private=True)
        assert all(p["name"] != "HR" for p in people_res["people"])
        zs_res = mcp_server.handle_tool_call("get_person_history", {"name": "张三"}, exclude_private=True)
        assert zs_res["total_meetings"] == 2
        assert all(c["name"] != "HR" for c in zs_res["co_speakers"])
        assert all("绝密" not in t for t in zs_res["top_terms"])

        todos_res = mcp_server.handle_tool_call("list_todos", {"status": "open"}, exclude_private=True)
        assert todos_res["counts"]["open"] == 2
        assert all(t["mid"] != m_priv for t in todos_res["items"])

        # 3) New tools: list_projects, list_commitments, get_daily_summary, get_weekly_digest, build_context_pack
        proj_res = mcp_server.handle_tool_call("list_projects", {"days": 30, "limit": 12}, exclude_private=True)
        assert proj_res["count"] >= 1
        assert any("apollo" in p["name"].lower() for p in proj_res["projects"])
        for p in proj_res["projects"]:
            assert "绝密" not in p["name"]
            assert "HR" not in p["participants"]
            assert all(m["id"] != m_priv for m in p["meetings"])

        comm_res = mcp_server.handle_tool_call("list_commitments", {"status": "open", "days": 14, "person": "张三"}, exclude_private=True)
        assert comm_res["counts"]["open"] >= 1
        assert all(c["mid"] != m_priv for c in comm_res["items"])
        assert all("绝密" not in c["text"] for c in comm_res["items"])

        daily_today = mcp_server.handle_tool_call("get_daily_summary", {}, exclude_private=True)
        assert daily_today["date"] == d_today
        assert daily_today["has_summary"] is True
        assert "Apollo" in daily_today["markdown"]
        assert daily_today["meeting_count"] == 2
        assert all(m["id"] != m_priv for m in daily_today["meetings"])

        daily_yest = mcp_server.handle_tool_call("get_daily_summary", {"date": d_yest}, exclude_private=True)
        assert daily_yest["date"] == d_yest
        assert daily_yest["has_summary"] is True and "昨日重点" in daily_yest["markdown"]

        weekly = mcp_server.handle_tool_call("get_weekly_digest", {"end_date": d_today}, exclude_private=True)
        assert weekly["meeting_count"] == 2
        assert all(m["id"] != m_priv for m in weekly["meetings"])
        assert all(t["mid"] != m_priv for t in weekly["todos"])
        assert all(c["mid"] != m_priv for c in weekly["commitments"])
        assert "绝密" not in weekly["draft_markdown"]

        pack = mcp_server.handle_tool_call(
            "build_context_pack",
            {"query": "Apollo 计费", "person": "张三", "days": 30, "max_chars": 12000},
            exclude_private=True,
        )
        assert len(pack["meetings"]) >= 1
        assert all(m["id"] != m_priv for m in pack["meetings"])
        assert len(pack["quotes"]) >= 1
        assert pack["quotes"][0]["ts"].startswith("[") and pack["quotes"][0]["ts"].endswith("]")
        assert len(pack["related_projects"]) >= 1
        assert len(pack["open_commitments"]) >= 1
        assert len(pack["open_todos"]) >= 1
        assert len(pack["daily_context"]) >= 1
        assert pack["weekly_context"] is not None
        assert "绝密" not in json.dumps(pack, ensure_ascii=False)

        # Strict max_chars budget enforcement
        tight_pack = mcp_server.handle_tool_call(
            "build_context_pack",
            {"query": "Apollo", "days": 30, "max_chars": 1200},
            exclude_private=True,
        )
        assert len(json.dumps(tight_pack, ensure_ascii=False, indent=2)) <= 1200
        assert tight_pack["budget"]["truncated"] is True

        # 4) Prompts: prompts/list & prompts/get (all 4 + error case)
        pr_list = mcp_server.handle_rpc({"jsonrpc": "2.0", "id": 10, "method": "prompts/list"})
        assert [p["name"] for p in pr_list["result"]["prompts"]] == [
            "pre-meeting-brief",
            "topic-deep-dive",
            "person-sync-prep",
            "weekly-context-review",
        ]
        for pname, pargs in [
            ("pre-meeting-brief", {"topic": "Apollo", "person": "张三", "days": "14"}),
            ("topic-deep-dive", {"topic": "Apollo", "days": "30"}),
            ("person-sync-prep", {"person": "张三", "days": "30"}),
            ("weekly-context-review", {"end_date": d_today}),
        ]:
            pr_get = mcp_server.handle_rpc(
                {"jsonrpc": "2.0", "id": 11, "method": "prompts/get", "params": {"name": pname, "arguments": pargs}}
            )
            assert "result" in pr_get
            msg_txt = pr_get["result"]["messages"][0]["content"]["text"]
            assert "《会议标题》" in msg_txt

        pr_err = mcp_server.handle_rpc(
            {"jsonrpc": "2.0", "id": 12, "method": "prompts/get", "params": {"name": "pre-meeting-brief", "arguments": {}}}
        )
        assert pr_err["error"]["code"] == -32602

        # 5) Resources: resources/list & resources/read (all 4 + privacy + error case)
        res_list = mcp_server.handle_rpc({"jsonrpc": "2.0", "id": 20, "method": "resources/list"})
        expected_uris = [
            "meeting://recent",
            "meeting://commitments/open",
            "meeting://todos/open",
            "meeting://projects/active",
        ]
        assert [r["uri"] for r in res_list["result"]["resources"]] == expected_uris
        for uri in expected_uris:
            rr = mcp_server.handle_rpc(
                {"jsonrpc": "2.0", "id": 21, "method": "resources/read", "params": {"uri": uri}},
                exclude_private=True,
            )
            c0 = rr["result"]["contents"][0]
            assert c0["uri"] == uri and c0["mimeType"] == "application/json"
            assert "绝密" not in c0["text"]
            assert json.loads(c0["text"])

        res_err = mcp_server.handle_rpc(
            {"jsonrpc": "2.0", "id": 22, "method": "resources/read", "params": {"uri": "meeting://nonexistent"}},
            exclude_private=True,
        )
        assert "error" in res_err

        # 6) Real stdio JSON-RPC subprocess test with --exclude-private
        env = {**os.environ, "MEETING_DATA": str(tmp)}
        req_lines = "\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_todos", "arguments": {"status": "open"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "build_context_pack", "arguments": {"query": "Apollo", "max_chars": 8000}}}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "prompts/list", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": {"uri": "meeting://recent"}}),
        ]) + "\n"
        proc = subprocess.run(
            [sys.executable, str(ROOT / "mcp_server.py"), "--exclude-private"],
            input=req_lines,
            text=True,
            capture_output=True,
            env=env,
            timeout=15,
            check=True,
        )
        assert proc.stderr == ""
        out_lines = [json.loads(ln) for ln in proc.stdout.strip().splitlines() if ln.strip()]
        assert len(out_lines) == 5
        assert out_lines[0]["result"]["serverInfo"]["version"] == "2.0.0"
        todos_payload = json.loads(out_lines[1]["result"]["content"][0]["text"])
        assert todos_payload["counts"]["open"] == 2
        assert all(t["mid"] != m_priv for t in todos_payload["items"])
        pack_payload = json.loads(out_lines[2]["result"]["content"][0]["text"])
        assert "绝密" not in json.dumps(pack_payload, ensure_ascii=False)
        assert len(out_lines[3]["result"]["prompts"]) == 4
        recent_payload = json.loads(out_lines[4]["result"]["contents"][0]["text"])
        assert recent_payload["count"] == 2


def test_markdown_todo_parity_with_frontend_js():
    node = shutil.which("node")
    assert node, "node must be installed to verify Python/JS markdown todo parity"
    fixture = (
        "## 待办\r\n"
        "- [ ] 第一条 [12:30, 13:05]\r\n"
        "```markdown\r\n"
        "- [ ] 围栏里不算\r\n"
        "```\r\n"
        "~~~\n"
        "1. [x] 波浪围栏也不算\n"
        "~~~\n"
        "1. [X] 第二条已完成 [01:02:03]\n"
        "  * [ ] 第三条子项\r\n"
    )
    py_items = relations.parse_markdown_todos(fixture)
    assert len(py_items) == 3
    assert [it["done"] for it in py_items] == [False, True, False]
    assert py_items[0]["ts"] == "12:30"
    assert py_items[1]["ts"] == "01:02:03"

    js_probe = (
        'globalThis.location={hostname:"127.0.0.1"};'
        'globalThis.matchMedia=()=>({matches:false});'
        'const fs=await import("node:fs");'
        'const {pathToFileURL}=await import("node:url");'
        'const m=await import(pathToFileURL(process.argv[1]).href);'
        'const src=fs.readFileSync(0,"utf8");'
        'const c=m.countMarkdownTodos(src);'
        'const toggled=[];'
        'for(let i=0;i<c.total;i++){'
        'toggled.push([m.toggleMarkdownTodo(src,i,true),m.toggleMarkdownTodo(src,i,false)]);'
        '}'
        'process.stdout.write(JSON.stringify({counts:c,toggled}));'
    )
    proc = subprocess.run(
        [node, "--input-type=module", "-e", js_probe, str((ROOT / "static/js/markdown.js").resolve())],
        input=fixture.encode("utf-8"),
        capture_output=True,
        timeout=15,
        check=True,
    )
    js_res = json.loads(proc.stdout.decode("utf-8"))
    assert js_res["counts"] == {"total": len(py_items), "done": sum(1 for x in py_items if x["done"])}
    for i, (js_true, js_false) in enumerate(js_res["toggled"]):
        py_true, ok_t = relations.toggle_markdown_todo(fixture, i, True)
        py_false, ok_f = relations.toggle_markdown_todo(fixture, i, False)
        assert ok_t and ok_f
        assert py_true == js_true, f"idx={i} true mismatch"
        assert py_false == js_false, f"idx={i} false mismatch"


def test_mcp_privacy_fail_closed_and_rpc_robustness():
    with _isolated() as tmp:
        today_dt = datetime.now()
        d_today = today_dt.strftime("%Y-%m-%d")
        d_old = (today_dt - timedelta(days=45)).strftime("%Y-%m-%d")

        m_pub = _seed_meeting(
            "公开产品评审",
            speakers={"0": "张三"},
            created=f"{d_today}T10:00:00",
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "公开讨论产品发布节奏。"}],
        )
        m_priv = _seed_meeting(
            "私密高管会议",
            speakers={"0": "HR"},
            created=f"{d_today}T15:00:00",
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "绝密期权方案不可外泄。"}],
            rsi_exclude=True,
        )
        # Notes search test on public meeting
        (store.mdir(m_pub) / "notes.txt").write_text("手写笔记：重点关注灰度指标。", encoding="utf-8")

        # Seed old (>30d) meetings for build_context_pack(days=0) unlimited verification
        _seed_meeting(
            "历史架构回顾一期",
            speakers={"0": "张三"},
            tags=["老项目"],
            created=f"{d_old}T10:00:00",
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "我明天把历史老项目迁移文档发给你。"}],
        )
        _seed_meeting(
            "历史架构回顾二期",
            speakers={"0": "张三"},
            tags=["老项目"],
            created=f"{d_old}T14:00:00",
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "继续推进老项目灰度验证。"}],
        )

        daily_dir = tmp / "daily"
        daily_dir.mkdir(parents=True, exist_ok=True)
        # P0-1a: Mixed daily summary referencing both public and private meeting -> MUST be hidden
        store.write_json(
            daily_dir / f"{d_today}.json",
            {
                "markdown": "## 今日总结\n包含绝密期权方案与公开讨论。",
                "created": f"{d_today}T21:00:00",
                "meetings": [m_pub, m_priv],
            },
        )
        # P0-2: Saved weekly report on a week containing a private meeting -> MUST be dropped
        import insights

        week_id, _, _ = insights.week_bounds(d_today)
        store.write_json(
            daily_dir / f"weekly-{week_id}.json",
            {
                "week_id": week_id,
                "markdown": "# 本周周报\n泄露绝密期权方案。",
                "created": f"{d_today}T22:00:00",
            },
        )

        # Verify notes search works
        note_hit = mcp_server.handle_tool_call("search_meetings", {"query": "手写笔记"}, exclude_private=True)
        assert note_hit["count"] == 1 and note_hit["hits"][0]["id"] == m_pub

        # Verify P0-1a (mixed daily summary hidden across daily, weekly, context pack)
        daily_res = mcp_server.handle_tool_call("get_daily_summary", {"date": d_today}, exclude_private=True)
        assert daily_res["has_summary"] is False
        assert "绝密" not in daily_res["markdown"]
        assert daily_res["meeting_count"] == 1

        wk_res = mcp_server.handle_tool_call("get_weekly_digest", {"end_date": d_today}, exclude_private=True)
        assert wk_res["report"] is None
        assert wk_res["daily_summaries"] == []
        assert "绝密" not in json.dumps(wk_res, ensure_ascii=False)

        pack_res = mcp_server.handle_tool_call("build_context_pack", {"days": 30}, exclude_private=True)
        assert "绝密" not in json.dumps(pack_res, ensure_ascii=False)
        assert pack_res["daily_context"] == []

        # P0-1b: Legacy daily summary (missing `meetings` field) on a day with any blocked meeting -> MUST be hidden
        store.write_json(
            daily_dir / f"{d_today}.json",
            {"markdown": "## 旧版日报\n无 meetings 字段但含绝密期权方案。", "created": f"{d_today}T21:00:00"},
        )
        daily_legacy = mcp_server.handle_tool_call("get_daily_summary", {"date": d_today}, exclude_private=True)
        assert daily_legacy["has_summary"] is False
        assert "绝密" not in daily_legacy["markdown"]

        # P2: build_context_pack(days=0) passes 0 (unlimited) through to projects and commitments
        pack_all = mcp_server.handle_tool_call("build_context_pack", {"query": "老项目", "days": 0}, exclude_private=True)
        assert len(pack_all["related_projects"]) >= 1
        assert len(pack_all["open_commitments"]) >= 1

        # P1-3 & P2: malformed JSON-RPC lines, non-object params, unknown tool (-32602), unknown notification (no reply)
        env = {**os.environ, "MEETING_DATA": str(tmp)}
        req_lines = "\n".join([
            "[]",
            '"just-a-string"',
            "123",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["not-an-object"]}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "no_such_tool", "arguments": {}}}),
            json.dumps({"jsonrpc": "2.0", "method": "unknown/notification", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
        ]) + "\n"
        proc = subprocess.run(
            [sys.executable, str(ROOT / "mcp_server.py"), "--exclude-private"],
            input=req_lines,
            text=True,
            capture_output=True,
            env=env,
            timeout=15,
            check=True,
        )
        assert proc.stderr == ""
        out = [json.loads(ln) for ln in proc.stdout.strip().splitlines() if ln.strip()]
        # 3 non-object requests + id=1 + id=2 + id=3 = 6 responses (notification gets none)
        assert len(out) == 6
        assert [r["error"]["code"] for r in out[:3]] == [-32600, -32600, -32600]
        assert out[3]["id"] == 1 and out[3]["error"]["code"] == -32602
        assert out[4]["id"] == 2 and out[4]["error"]["code"] == -32602
        assert out[5] == {"jsonrpc": "2.0", "id": 3, "result": {}}


if __name__ == "__main__":
    test_related_meetings_and_people_timeline()
    test_todos_api_toggle_and_fenced_code_safety()
    test_mcp_server_rpc_and_stdio_privacy()
    test_mcp_privacy_fail_closed_and_rpc_robustness()
    test_markdown_todo_parity_with_frontend_js()
    print("ALL RELATIONS & MCP TESTS PASS")
