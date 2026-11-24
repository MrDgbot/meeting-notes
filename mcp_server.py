#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import relations
import store
import vocab

SERVER_INFO = {"name": "meeting-notes", "version": "1.0.0"}
PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "list_meetings",
        "description": "列出本机最近的会议与全天录音记录（含标题、日期、时长、来源和发言人）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "最多返回条数，默认 20（最大 100）", "default": 20},
                "kind": {
                    "type": "string",
                    "enum": ["all", "meeting", "ambient", "upload"],
                    "description": "按来源筛选：all / meeting / ambient / upload",
                    "default": "all",
                },
            },
        },
    },
    {
        "name": "search_meetings",
        "description": "跨全部会议标题、转写稿、AI 纪要和笔记进行关键词搜索，返回命中片段。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要搜索的关键词或短语"},
                "limit": {"type": "integer", "description": "最多返回命中会议数，默认 10", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_meeting",
        "description": "读取指定会议的完整详情：元信息、AI 纪要、用户笔记、打点与（可选）转写稿。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mid": {"type": "string", "description": "会议 ID"},
                "include_transcript": {"type": "boolean", "description": "是否包含转写全文，默认 true", "default": True},
                "max_chars": {"type": "integer", "description": "转写最大字符数，默认 24000", "default": 24000},
            },
            "required": ["mid"],
        },
    },
    {
        "name": "get_related_meetings",
        "description": "查找与指定会议最相关的历史会议（基于共同参会人与主题词关联）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mid": {"type": "string", "description": "会议 ID"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 5", "default": 5},
            },
            "required": ["mid"],
        },
    },
    {
        "name": "get_person_history",
        "description": "查询某个具名说话人的全部历史会议、共同参会人、高频讨论话题与相关待办。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "说话人姓名（留空则返回所有人物列表）"},
            },
        },
    },
    {
        "name": "list_todos",
        "description": "聚合全部会议纪要里的待办事项（含来源会议与时间戳），可按完成状态或人物筛选。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["open", "done", "all"], "default": "open"},
                "person": {"type": "string", "description": "可选：按人名筛选", "default": ""},
                "limit": {"type": "integer", "default": 100},
            },
        },
    },
]


def _is_blocked(meta: dict | None, exclude_private: bool) -> bool:
    return bool(exclude_private and isinstance(meta, dict) and meta.get("rsi_exclude"))


def _fmt_ts(ms: int | float) -> str:
    s = max(0, int((ms or 0) // 1000))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def handle_tool_call(name: str, args: dict[str, Any], exclude_private: bool = False) -> dict[str, Any]:
    if name == "list_meetings":
        limit = max(1, min(100, int(args.get("limit") or 20)))
        kind = str(args.get("kind") or "all")
        items = []
        for m in store.list_all():
            if _is_blocked(m, exclude_private):
                continue
            src = m.get("source") or "mic"
            if kind == "ambient" and src != "ambient":
                continue
            if kind == "upload" and src != "upload":
                continue
            if kind == "meeting" and src in ("ambient", "upload"):
                continue
            spks = [str(v).strip() for v in (m.get("speakers") or {}).values() if relations.is_named_speaker(v)]
            items.append({
                "id": m.get("id"),
                "title": m.get("title"),
                "created": m.get("created"),
                "source": src,
                "status": m.get("status"),
                "duration_s": m.get("speech_s") if src == "ambient" else m.get("duration", 0),
                "speakers": spks,
            })
            if len(items) >= limit:
                break
        return {"count": len(items), "meetings": items}

    if name == "search_meetings":
        q = str(args.get("query") or "").strip()
        if not q:
            return {"query": "", "hits": []}
        ql = q.lower()
        limit = max(1, min(50, int(args.get("limit") or 10)))
        hits = []
        for m in store.list_all():
            if _is_blocked(m, exclude_private):
                continue
            mid = m.get("id")
            if not mid:
                continue
            snippets: list[str] = []
            title = str(m.get("title") or "")
            if ql in title.lower():
                snippets.append(f"[标题] {title}")
            mn = store.load(mid, "minutes.json")
            if isinstance(mn, dict) and mn.get("markdown"):
                md_txt = str(mn["markdown"])
                pos = md_txt.lower().find(ql)
                if pos >= 0:
                    s0 = max(0, pos - 40)
                    snippets.append(f"[纪要] {md_txt[s0:pos + len(q) + 80].replace(chr(10), ' ')}")
            tr = store.load(mid, "transcript.json")
            if isinstance(tr, dict) and tr.get("paragraphs"):
                for p in tr["paragraphs"]:
                    txt = vocab.apply(str(p.get("text") or "")) if not p.get("edited") else str(p.get("text") or "")
                    pos = txt.lower().find(ql)
                    if pos >= 0:
                        s0 = max(0, pos - 30)
                        snippets.append(f"[{_fmt_ts(p.get('start', 0))}] {txt[s0:pos + len(q) + 70]}")
                        if len(snippets) >= 3:
                            break
            if snippets:
                hits.append({
                    "id": mid,
                    "title": title,
                    "created": m.get("created"),
                    "snippets": snippets[:3],
                })
                if len(hits) >= limit:
                    break
        return {"query": q, "count": len(hits), "hits": hits}

    if name == "get_meeting":
        mid = str(args.get("mid") or "").strip()
        meta = store.get(mid)
        if not meta or _is_blocked(meta, exclude_private):
            raise ValueError(f"找不到会议或已设为隐私：{mid}")
        mn = store.load(mid, "minutes.json")
        notes_p = store.MEETINGS / mid / "notes.txt"
        notes = notes_p.read_text(encoding="utf-8", errors="ignore") if notes_p.exists() else ""
        marks = store.load(mid, "marks.json") or []
        out: dict[str, Any] = {
            "meta": {
                "id": meta.get("id"),
                "title": meta.get("title"),
                "created": meta.get("created"),
                "source": meta.get("source"),
                "duration_s": meta.get("speech_s") if meta.get("source") == "ambient" else meta.get("duration", 0),
                "speakers": meta.get("speakers") or {},
            },
            "minutes_markdown": mn.get("markdown", "") if isinstance(mn, dict) else "",
            "notes": notes,
            "marks": marks,
        }
        if args.get("include_transcript", True):
            max_chars = max(1000, min(100000, int(args.get("max_chars") or 24000)))
            tr = store.load(mid, "transcript.json")
            spks = meta.get("speakers") or {}
            lines = []
            total = 0
            truncated = False
            if isinstance(tr, dict) and tr.get("paragraphs"):
                for p in tr["paragraphs"]:
                    spk_id = p.get("spk", -1)
                    who = spks.get(str(spk_id)) or (f"说话人{spk_id + 1}" if isinstance(spk_id, int) and spk_id >= 0 else "")
                    txt = vocab.apply(str(p.get("text") or "")) if not p.get("edited") else str(p.get("text") or "")
                    ln = f"[{_fmt_ts(p.get('start', 0))}] {who + '：' if who else ''}{txt}"
                    if total + len(ln) > max_chars:
                        truncated = True
                        break
                    lines.append(ln)
                    total += len(ln) + 1
            out["transcript"] = "\n".join(lines)
            out["transcript_truncated"] = truncated
        return out

    if name == "get_related_meetings":
        mid = str(args.get("mid") or "").strip()
        meta = store.get(mid)
        if not meta or _is_blocked(meta, exclude_private):
            raise ValueError(f"找不到会议或已设为隐私：{mid}")
        limit = max(1, min(20, int(args.get("limit") or 5)))
        items = relations.related_meetings(mid, limit=limit)
        if exclude_private:
            items = [x for x in items if not _is_blocked(store.get(x["id"]), True)]
        return {"mid": mid, "items": items}

    if name == "get_person_history":
        pname = str(args.get("name") or "").strip()
        if not pname:
            return {"people": relations.list_people()}
        tl = relations.person_timeline(pname)
        if exclude_private:
            tl["meetings"] = [m for m in tl["meetings"] if not _is_blocked(store.get(m["id"]), True)]
            tl["todos"] = [t for t in tl["todos"] if not _is_blocked(store.get(t["mid"]), True)]
            tl["total_meetings"] = len(tl["meetings"])
        return tl

    if name == "list_todos":
        status = str(args.get("status") or "open")
        person = str(args.get("person") or "")
        limit = max(1, min(500, int(args.get("limit") or 100)))
        res = relations.list_todos(status=status, person=person, limit=limit)
        if exclude_private:
            res["items"] = [t for t in res["items"] if not _is_blocked(store.get(t["mid"]), True)]
        return res

    raise ValueError(f"未知工具：{name}")


def handle_rpc(msg: dict[str, Any], exclude_private: bool = False) -> dict[str, Any] | None:
    req_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "notifications/initialized" or (req_id is None and str(method or "").startswith("notifications/")):
        return None
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        tname = str(params.get("name") or "")
        targs = params.get("arguments") or {}
        try:
            data = handle_tool_call(tname, targs, exclude_private=exclude_private)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=2)}],
                    "isError": False,
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                    "isError": True,
                },
            }
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    ap = argparse.ArgumentParser(description="meeting-notes local read-only MCP server (stdio)")
    ap.add_argument("--exclude-private", action="store_true", help="跳过标记了隐私会议的记录")
    ns = ap.parse_args()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            resp = handle_rpc(msg, exclude_private=ns.exclude_private)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
