"""测试跨会议关联引擎（relations.py）、REST API 与本机 stdio MCP Server（mcp_server.py）。"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
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
    rsi_exclude: bool = False,
) -> str:
    meta = store.create(title=title, hotword=hotword)
    mid = meta["id"]
    patch = {"status": "ready", "duration": 600.0}
    if speakers:
        patch["speakers"] = speakers
    if rsi_exclude:
        patch["rsi_exclude"] = True
    store.update(mid, **patch)
    if paragraphs:
        store.save(mid, "transcript.json", {"asr": "paraformer", "cost": 1.2, "paragraphs": paragraphs})
    if minutes_md:
        store.save(mid, "minutes.json", {"markdown": minutes_md, "provider": "test", "model": "m", "created": meta["created"], "cost": 1.0})
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
        assert "meeting-notes" in rmcp.json()["config"]["mcpServers"]


def test_mcp_server_rpc_and_stdio_privacy():
    with _isolated() as tmp:
        m_pub = _seed_meeting(
            "季度 OKR 对齐",
            speakers={"0": "张三"},
            paragraphs=[{"start": 1000, "end": 8000, "spk": 0, "text": "本季度核心 OKR 是提升转化率。"}],
            minutes_md="## 待办\n- [ ] 张三 拆解 Q3 OKR 指标\n",
        )
        m_priv = _seed_meeting(
            "私密薪酬讨论",
            speakers={"0": "HR"},
            paragraphs=[{"start": 0, "end": 5000, "spk": 0, "text": "绝密薪酬方案"}],
            rsi_exclude=True,
        )

        init_r = mcp_server.handle_rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        assert init_r["result"]["serverInfo"]["name"] == "meeting-notes"
        tools_r = mcp_server.handle_rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert len(tools_r["result"]["tools"]) == 6

        search_priv = mcp_server.handle_tool_call("search_meetings", {"query": "绝密"}, exclude_private=True)
        assert search_priv["count"] == 0
        search_pub = mcp_server.handle_tool_call("search_meetings", {"query": "OKR"}, exclude_private=True)
        assert search_pub["count"] == 1 and search_pub["hits"][0]["id"] == m_pub

        env = {**os.environ, "MEETING_DATA": str(tmp)}
        req_lines = "\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_todos", "arguments": {"status": "open"}}}),
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
        out_lines = [json.loads(ln) for ln in proc.stdout.strip().splitlines() if ln.strip()]
        assert len(out_lines) == 2
        todos_payload = json.loads(out_lines[1]["result"]["content"][0]["text"])
        assert todos_payload["counts"]["open"] == 1
        assert all(t["mid"] != m_priv for t in todos_payload["items"])


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
        input=fixture,
        text=True,
        capture_output=True,
        timeout=15,
        check=True,
    )
    js_res = json.loads(proc.stdout)
    assert js_res["counts"] == {"total": len(py_items), "done": sum(1 for x in py_items if x["done"])}
    for i, (js_true, js_false) in enumerate(js_res["toggled"]):
        py_true, ok_t = relations.toggle_markdown_todo(fixture, i, True)
        py_false, ok_f = relations.toggle_markdown_todo(fixture, i, False)
        assert ok_t and ok_f
        assert py_true == js_true, f"idx={i} true mismatch"
        assert py_false == js_false, f"idx={i} false mismatch"


if __name__ == "__main__":
    test_related_meetings_and_people_timeline()
    test_todos_api_toggle_and_fenced_code_safety()
    test_mcp_server_rpc_and_stdio_privacy()
    test_markdown_todo_parity_with_frontend_js()
    print("ALL RELATIONS & MCP TESTS PASS")
