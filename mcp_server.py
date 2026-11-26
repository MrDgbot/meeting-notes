#!/usr/bin/env python3
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta
import json
import math
from pathlib import Path
import re
import sys
from typing import Any

import insights
import relations
import store
import vocab

SERVER_INFO = {"name": "meeting-notes", "version": "2.0.0"}
PROTOCOL_VERSION = "2024-11-05"

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

TOOLS = [
    {
        "name": "list_meetings",
        "description": "列出本机最近的会议与全天录音记录（含标题、日期、时长、来源、摘要、标签和发言人）。",
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
        "description": "跨全部会议标题、摘要、转写稿与 AI 纪要进行分词相关性评分与关键词检索，返回命中片段与时间戳。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要搜索的关键词、短语或问题"},
                "limit": {"type": "integer", "description": "最多返回命中会议数，默认 10", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_meeting",
        "description": "读取指定会议的完整详情：元信息、AI 纪要、用户笔记、打点与（可选）带时间戳转写稿。",
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
    {
        "name": "build_context_pack",
        "description": "一站式打包会议记忆上下文：按主题/人物/时间窗聚合匹配会议、高分原话引用（含 [MM:SS]）、关联项目、未完成承诺、待办及近期日报/周报上下文，并严格控制在字符预算内。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "可选：主题、项目名或问题关键词", "default": ""},
                "person": {"type": "string", "description": "可选：聚焦的参会人或协作对象姓名", "default": ""},
                "days": {"type": "integer", "description": "回溯天数，默认 30（0 表示不限时间）", "default": 30},
                "max_chars": {"type": "integer", "description": "返回上下文字符预算，默认 12000", "default": 12000},
            },
        },
    },
    {
        "name": "list_projects",
        "description": "按共享主题词与标签自动聚合成项目脉络列表（含关联会议数、参与人、关键词与会议清单）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "统计回溯天数，默认 30（0 表示全部）", "default": 30},
                "limit": {"type": "integer", "description": "最多返回项目数，默认 12", "default": 12},
            },
        },
    },
    {
        "name": "list_commitments",
        "description": "聚合近 N 天会议与日常对话中的口头承诺（我方承诺 / 待对方反馈、是否超期），支持按状态和人物筛选。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["open", "done", "all"], "default": "open"},
                "days": {"type": "integer", "description": "回溯天数，默认 14（0 表示不限）", "default": 14},
                "person": {"type": "string", "description": "可选：按承诺人/参会人/内容人名筛选", "default": ""},
            },
        },
    },
    {
        "name": "get_daily_summary",
        "description": "读取指定日期（默认今天或最近有记录的一天）的已保存每日总结 Markdown 与当日会议列表。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "可选：日期 YYYY-MM-DD（留空则默认今天或最近可用日期）", "default": ""},
            },
        },
    },
    {
        "name": "get_weekly_digest",
        "description": "汇总指定日期所在自然周的会议记录、每日总结、待办、口头承诺与已保存周报（含无模型兜底草稿）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "end_date": {"type": "string", "description": "可选：周内任意日期 YYYY-MM-DD（留空默认本周）", "default": ""},
            },
        },
    },
]

PROMPTS = [
    {
        "name": "pre-meeting-brief",
        "description": "生成会前简报：梳理历史决议、未完成承诺/待办、关键原话证据与本次建议议程。",
        "arguments": [
            {"name": "topic", "description": "本次会议的主题、项目或关键词", "required": True},
            {"name": "person", "description": "可选：重点参会人姓名", "required": False},
            {"name": "days", "description": "可选：回溯天数（默认 30）", "required": False},
        ],
    },
    {
        "name": "topic-deep-dive",
        "description": "专题脉络复盘：按时间线还原某个项目或议题的演进、已定结论、分歧与遗留风险。",
        "arguments": [
            {"name": "topic", "description": "专题/项目名称或关键词", "required": True},
            {"name": "days", "description": "可选：回溯天数（默认 60）", "required": False},
        ],
    },
    {
        "name": "person-sync-prep",
        "description": "1v1 / 人物同步准备：梳理与某人的历史交集、双方未闭环承诺、待办与上次沟通要点。",
        "arguments": [
            {"name": "person", "description": "对方姓名", "required": True},
            {"name": "days", "description": "可选：回溯天数（默认 45）", "required": False},
        ],
    },
    {
        "name": "weekly-context-review",
        "description": "周度上下文复盘：基于本周会议、日报、待办与承诺提炼核心产出、卡点与下周重点。",
        "arguments": [
            {"name": "end_date", "description": "可选：周内任意日期 YYYY-MM-DD（留空默认本周）", "required": False},
        ],
    },
]

RESOURCES = [
    {
        "uri": "meeting://recent",
        "name": "近期会议列表",
        "description": "最近 20 场本机会议与全天录音的结构化清单（含标题、摘要、标签与发言人）。",
        "mimeType": "application/json",
    },
    {
        "uri": "meeting://commitments/open",
        "name": "未完成口头承诺",
        "description": "近 30 天内尚未闭环的口头承诺（区分我方承诺与待对方反馈，含超期标记）。",
        "mimeType": "application/json",
    },
    {
        "uri": "meeting://todos/open",
        "name": "未完成会议待办",
        "description": "跨会议聚合的未完成 Markdown 待办清单（含来源会议与时间戳）。",
        "mimeType": "application/json",
    },
    {
        "uri": "meeting://projects/active",
        "name": "近期活跃项目脉络",
        "description": "近 30 天自动聚类的活跃项目/专题及其关联会议与参与人。",
        "mimeType": "application/json",
    },
]


_TOOL_NAMES = frozenset(t["name"] for t in TOOLS)


def _daily_dir() -> Path:
    return store.DATA / "daily"


def _is_blocked(meta: dict | None, exclude_private: bool) -> bool:
    return bool(exclude_private and isinstance(meta, dict) and meta.get("rsi_exclude"))


def _safe_get_meta(mid: str) -> dict | None:
    if not mid:
        return None
    try:
        return store.get(mid)
    except ValueError:
        return None


def _fmt_ts(ms: int | float) -> str:
    s = max(0, int((ms or 0) // 1000))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _int_arg(args: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    raw = args.get(key)
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        return default
    try:
        val = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, val))


def _validate_ymd(raw: str, label: str = "date") -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    if not _DATE_RE.fullmatch(s):
        raise ValueError(f"{label} 格式须为 YYYY-MM-DD：{s}")
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError as e:
        raise ValueError(f"无效日期 {label}：{s}") from e
    return s


def _named_speakers(meta: dict) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for v in (meta.get("speakers") or {}).values():
        s = str(v or "").strip()
        if relations.is_named_speaker(s) and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _duration_s(meta: dict) -> float:
    src = meta.get("source") or "mic"
    if src == "ambient" and meta.get("speech_s"):
        return float(meta.get("speech_s") or 0)
    return float(meta.get("duration") or 0)


def _meeting_summary_row(meta: dict) -> dict[str, Any]:
    src = meta.get("source") or "mic"
    return {
        "id": meta.get("id"),
        "title": meta.get("title") or meta.get("id"),
        "created": meta.get("created") or "",
        "source": src,
        "status": meta.get("status") or "",
        "duration_s": _duration_s(meta),
        "brief": str(meta.get("brief") or ""),
        "tags": list(meta.get("tags") or []),
        "speakers": _named_speakers(meta),
    }


def _load_paras(mid: str) -> list[dict]:
    tr = store.load(mid, "transcript.json")
    if isinstance(tr, dict) and tr.get("paragraphs"):
        return [p for p in tr["paragraphs"] if isinstance(p, dict) and str(p.get("text") or "").strip()]
    live = store.load(mid, "live.json")
    if isinstance(live, list):
        return [
            {
                "start": int(x.get("start") or 0),
                "end": int(x.get("end") or 0),
                "spk": int(x["ch"]) if isinstance(x.get("ch"), int) else -1,
                "ch": x.get("ch"),
                "text": str(x["text"]),
                "edited": bool(x.get("edited")),
            }
            for x in live
            if isinstance(x, dict) and str(x.get("text") or "").strip()
        ]
    return []


def _para_text(p: dict) -> str:
    raw = str(p.get("text") or "")
    return raw if p.get("edited") else vocab.apply(raw)


def _speaker_label(meta: dict, p: dict) -> str:
    spk = p.get("spk")
    speakers = meta.get("speakers") or {}
    if spk is not None:
        raw = str(speakers.get(str(spk)) or speakers.get(spk) or "").strip()
        if raw:
            return raw
        try:
            si = int(spk)
            if si >= 0:
                return f"说话人{si + 1}"
        except (TypeError, ValueError):
            pass
    ch = p.get("ch")
    if ch == 0:
        return str(speakers.get("ch0") or "我")
    if ch == 1:
        return str(speakers.get("ch1") or "对方")
    return ""


def _load_notes(mid: str) -> str:
    try:
        md_dir = store.mdir(mid)
    except ValueError:
        return ""
    notes_p = md_dir / "notes.txt"
    if not notes_p.exists() and (md_dir / "notes.md").exists():
        notes_p = md_dir / "notes.md"
    if not notes_p.exists():
        return ""
    try:
        return notes_p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _daily_summary_hidden(rec: dict | None, date_ymd: str, exclude_private: bool) -> bool:
    if not exclude_private or not isinstance(rec, dict):
        return False
    mids = rec.get("meetings")
    if isinstance(mids, list) and mids:
        return any(_is_blocked(_safe_get_meta(str(mid)), True) for mid in mids)
    if date_ymd and _DATE_RE.fullmatch(date_ymd):
        return any(_is_blocked(m, True) for m in store.list_by_date(date_ymd))
    return False


def _search_meetings_impl(query: str, limit: int, exclude_private: bool) -> dict[str, Any]:
    q = str(query or "").strip()
    if not q:
        return {"query": "", "count": 0, "hits": []}
    ql = q.lower()
    q_tokens = {t.lower() for t in relations._extract_tokens(q)}
    limit = max(1, min(50, limit))

    by_mid: dict[str, dict[str, Any]] = {}

    def ensure_entry(meta: dict) -> dict[str, Any]:
        mid = str(meta.get("id") or "")
        entry = by_mid.get(mid)
        if entry is None:
            entry = {
                "id": mid,
                "title": str(meta.get("title") or mid),
                "created": str(meta.get("created") or ""),
                "brief": str(meta.get("brief") or ""),
                "tags": list(meta.get("tags") or []),
                "score": 0.0,
                "snippets": [],
                "_seen": set(),
            }
            by_mid[mid] = entry
        return entry

    def add_snippet(entry: dict[str, Any], text: str) -> None:
        cleaned = str(text or "").strip()
        if not cleaned:
            return
        key = re.sub(r"\s+", " ", cleaned)[:80]
        if key not in entry["_seen"] and len(entry["snippets"]) < 4:
            entry["_seen"].add(key)
            entry["snippets"].append(cleaned)

    # 1) Tokenized semantic/global scoring from insights.retrieve_global_context when available
    if hasattr(insights, "retrieve_global_context"):
        try:
            ctx_hits = insights.retrieve_global_context(q, limit=min(16, max(8, limit * 2)))
        except Exception:  # noqa: BLE001
            ctx_hits = []
        for c in ctx_hits:
            mid = str(c.get("mid") or "")
            meta = _safe_get_meta(mid)
            if not meta or _is_blocked(meta, exclude_private):
                continue
            entry = ensure_entry(meta)
            entry["score"] = max(entry["score"], float(c.get("score") or 0.0))
            who = str(c.get("speaker") or "").strip()
            ts = str(c.get("ts") or "00:00").strip()
            quote = str(c.get("quote") or "").strip()
            if quote:
                add_snippet(entry, f"[{ts}] {who + '：' if who else ''}{quote}")

    # 2) Direct scan over title, brief, tags, minutes, and transcript (honoring exclude_private)
    for meta in store.list_all():
        if _is_blocked(meta, exclude_private):
            continue
        mid = str(meta.get("id") or "")
        if not mid:
            continue

        title = str(meta.get("title") or "")
        brief = str(meta.get("brief") or "")
        tags = [str(t) for t in (meta.get("tags") or []) if str(t).strip()]
        local_score = 0.0
        local_snips: list[str] = []

        if ql in title.lower():
            local_score += 5.0
            local_snips.append(f"[标题] {title}")
        elif q_tokens:
            t_toks = {t.lower() for t in relations._extract_tokens(f"{title} {brief} {' '.join(tags)}")}
            ov = len(q_tokens & t_toks)
            if ov:
                local_score += 1.5 * ov

        if brief and ql in brief.lower():
            local_score += 3.5
            local_snips.append(f"[摘要] {brief}")
        if tags and any(ql in t.lower() for t in tags):
            local_score += 2.5

        mn = store.load(mid, "minutes.json")
        if isinstance(mn, dict) and mn.get("markdown"):
            md_txt = str(mn["markdown"])
            md_l = md_txt.lower()
            pos = md_l.find(ql)
            if pos >= 0:
                s0 = max(0, pos - 40)
                local_score += 4.0
                local_snips.append(f"[纪要] {md_txt[s0 : pos + len(q) + 80].replace(chr(10), ' ')}")
            elif q_tokens:
                tok_hits = [t for t in q_tokens if len(t) >= 2 and t in md_l]
                if tok_hits:
                    pos2 = md_l.find(tok_hits[0])
                    s0 = max(0, pos2 - 40)
                    local_score += 1.2 * len(tok_hits)
                    local_snips.append(f"[纪要] {md_txt[s0 : pos2 + len(tok_hits[0]) + 80].replace(chr(10), ' ')}")

        notes_txt = _load_notes(mid)
        if notes_txt:
            nl = notes_txt.lower()
            pos = nl.find(ql)
            if pos >= 0:
                s0 = max(0, pos - 40)
                local_score += 4.0
                local_snips.append(f"[笔记] {notes_txt[s0 : pos + len(q) + 80].replace(chr(10), ' ')}")
            elif q_tokens:
                ntok_hits = [t for t in q_tokens if len(t) >= 2 and t in nl]
                if ntok_hits:
                    pos2 = nl.find(ntok_hits[0])
                    s0 = max(0, pos2 - 40)
                    local_score += 1.2 * len(ntok_hits)
                    local_snips.append(f"[笔记] {notes_txt[s0 : pos2 + len(ntok_hits[0]) + 80].replace(chr(10), ' ')}")

        paras = _load_paras(mid)
        para_matches = 0
        for p in paras:
            txt = _para_text(p).strip()
            if not txt:
                continue
            tl = txt.lower()
            pos = tl.find(ql)
            if pos >= 0:
                s0 = max(0, pos - 30)
                local_score += 4.5
                local_snips.append(f"[{_fmt_ts(p.get('start', 0))}] {txt[s0 : pos + len(q) + 70]}")
                para_matches += 1
                if para_matches >= 2:
                    break
            elif q_tokens and para_matches == 0:
                p_toks = {t.lower() for t in relations._extract_tokens(txt)}
                ov = len(q_tokens & p_toks)
                if ov >= max(1, min(2, len(q_tokens))):
                    local_score += 2.0 * ov / math.sqrt(max(1, len(p_toks)))
                    local_snips.append(f"[{_fmt_ts(p.get('start', 0))}] {txt[:120]}")
                    para_matches += 1

        if local_snips or (mid in by_mid and local_score > 0):
            entry = ensure_entry(meta)
            entry["score"] = round(max(entry["score"], local_score) + (0.5 if entry["score"] > 0 and local_score > 0 else 0.0), 3)
            for sn in local_snips:
                add_snippet(entry, sn)

    ranked = sorted(by_mid.values(), key=lambda x: (float(x["score"]), x["created"]), reverse=True)
    hits = [
        {
            "id": x["id"],
            "title": x["title"],
            "created": x["created"],
            "brief": x["brief"],
            "tags": x["tags"],
            "score": round(float(x["score"]), 3),
            "snippets": x["snippets"][:4],
        }
        for x in ranked[:limit]
    ]
    return {"query": q, "count": len(hits), "hits": hits}


def _list_people_filtered(exclude_private: bool) -> list[dict[str, Any]]:
    if not exclude_private:
        return relations.list_people()
    people: dict[str, dict[str, Any]] = {}
    for meta in store.list_all():
        if _is_blocked(meta, True):
            continue
        mid = str(meta.get("id") or "")
        if not mid:
            continue
        spks = set(_named_speakers(meta))
        if not spks:
            continue
        dur = _duration_s(meta)
        created = str(meta.get("created") or "")
        mn = store.load(mid, "minutes.json")
        todos = relations.parse_markdown_todos(mn["markdown"]) if isinstance(mn, dict) and mn.get("markdown") else []
        open_todos = sum(1 for t in todos if not t["done"])
        for pname in spks:
            rec = people.setdefault(
                pname,
                {"name": pname, "meetings": 0, "total_s": 0.0, "open_todos": 0, "last_seen": ""},
            )
            rec["meetings"] += 1
            rec["total_s"] += dur
            rec["open_todos"] += open_todos
            if created > rec["last_seen"]:
                rec["last_seen"] = created
    res = sorted(people.values(), key=lambda x: (x["meetings"], x["last_seen"]), reverse=True)
    for r in res:
        r["total_s"] = round(float(r["total_s"]), 1)
    return res


def _person_history_filtered(pname: str, exclude_private: bool) -> dict[str, Any]:
    if not exclude_private:
        return relations.person_timeline(pname)
    target = str(pname or "").strip()
    if not target:
        return relations.person_timeline("")

    meetings_out: list[dict[str, Any]] = []
    co_counts: Counter[str] = Counter()
    term_counts: Counter[str] = Counter()
    term_display: dict[str, str] = {}
    todos_out: list[dict[str, Any]] = []
    total_s = 0.0

    for meta in store.list_all():
        if _is_blocked(meta, True):
            continue
        mid = str(meta.get("id") or "")
        if not mid:
            continue
        spk_map = meta.get("speakers") or {}
        named_ids = {k for k, v in spk_map.items() if str(v or "").strip() == target}
        if not named_ids:
            continue

        prof = relations._meeting_profile(meta)
        spoken_s = 0.0
        tr = store.load(mid, "transcript.json")
        if isinstance(tr, dict) and tr.get("paragraphs"):
            for p in tr["paragraphs"]:
                if str(p.get("spk")) in named_ids:
                    spoken_s += max(0.0, (float(p.get("end") or 0) - float(p.get("start") or 0)) / 1000.0)
        if spoken_s <= 0:
            spoken_s = float(prof["duration"] or 0)
        total_s += spoken_s

        for s in prof["speakers"]:
            if s != target:
                co_counts[s] += 1
        for k, w in prof["terms"].items():
            if k != target.lower() and len(k) >= 2:
                term_counts[k] += math.log1p(w)
                term_display[k] = prof["display"].get(k, k)

        mn = store.load(mid, "minutes.json")
        if isinstance(mn, dict) and mn.get("markdown"):
            for t in relations.parse_markdown_todos(mn["markdown"]):
                todos_out.append({
                    "mid": mid,
                    "meeting_title": prof["title"],
                    "meeting_created": prof["created"],
                    "idx": t["idx"],
                    "done": t["done"],
                    "text": t["text"],
                    "ts": t["ts"],
                })

        meetings_out.append({
            "id": mid,
            "title": prof["title"],
            "created": prof["created"],
            "duration": prof["duration"],
            "spoken_s": round(spoken_s, 1),
            "source": prof["source"],
            "has_minutes": prof["has_minutes"],
            "spks": sorted(named_ids),
        })

    return {
        "name": target,
        "total_meetings": len(meetings_out),
        "total_s": round(total_s, 1),
        "meetings": meetings_out,
        "co_speakers": [{"name": n, "count": c} for n, c in co_counts.most_common(10)],
        "top_terms": [term_display[k] for k, _ in term_counts.most_common(12)],
        "todos": todos_out,
    }


def _list_todos_filtered(status: str, person: str, limit: int, exclude_private: bool) -> dict[str, Any]:
    status = status if status in ("open", "done", "all") else "open"
    person_q = str(person or "").strip()
    limit = max(1, min(500, limit))
    if not exclude_private:
        return relations.list_todos(status=status, person=person_q, limit=limit)

    raw_all = relations.list_todos(status="all", person=person_q, limit=500)
    visible = [t for t in (raw_all.get("items") or []) if not _is_blocked(_safe_get_meta(str(t.get("mid") or "")), True)]
    open_cnt = sum(1 for t in visible if not t.get("done"))
    done_cnt = sum(1 for t in visible if t.get("done"))
    if status == "open":
        items = [t for t in visible if not t.get("done")]
    elif status == "done":
        items = [t for t in visible if t.get("done")]
    else:
        items = visible
    return {
        "counts": {"open": open_cnt, "done": done_cnt, "total": open_cnt + done_cnt},
        "items": items[:limit],
    }


def _list_projects_filtered(days: int, limit: int, exclude_private: bool) -> dict[str, Any]:
    days = max(0, min(365, days))
    limit = max(1, min(30, limit))
    raw_projects = relations.list_projects(days=days, limit=30 if exclude_private else limit)
    if not exclude_private:
        return {"days": days, "count": len(raw_projects), "projects": raw_projects[:limit]}

    filtered: list[dict[str, Any]] = []
    for pr in raw_projects:
        kept_meetings: list[dict[str, Any]] = []
        part_counts: Counter[str] = Counter()
        visible_text_chunks: list[str] = []
        visible_terms: set[str] = set()
        total_s = 0.0
        for m in pr.get("meetings") or []:
            mid = str(m.get("id") or "")
            meta = _safe_get_meta(mid)
            if not meta or _is_blocked(meta, True):
                continue
            kept_meetings.append(m)
            total_s += _duration_s(meta)
            for spk in _named_speakers(meta):
                part_counts[spk] += 1
            prof = relations._meeting_profile(meta)
            visible_terms.update(k.lower() for k in (prof.get("terms") or {}))
            visible_text_chunks.append(str(meta.get("title") or "").lower())
            visible_text_chunks.extend(str(t).lower() for t in (meta.get("tags") or []))
        if len(kept_meetings) < 2:
            continue
        blob = " ".join(visible_text_chunks)
        kept_keywords = [
            kw for kw in (pr.get("keywords") or [])
            if str(kw).lower() in visible_terms or str(kw).lower() in blob
        ]
        if not kept_keywords:
            continue
        new_pr = {
            **pr,
            "name": kept_keywords[0],
            "keywords": kept_keywords,
            "meeting_count": len(kept_meetings),
            "total_s": round(total_s, 1),
            "latest_at": kept_meetings[0].get("created") or "",
            "participants": [n for n, _ in part_counts.most_common(6)],
            "meetings": kept_meetings,
        }
        filtered.append(new_pr)
        if len(filtered) >= limit:
            break
    return {"days": days, "count": len(filtered), "projects": filtered}


def _list_commitments_filtered(status: str, days: int, person: str, exclude_private: bool) -> dict[str, Any]:
    status = status if status in ("open", "done", "all") else "open"
    days = max(0, min(365, days))
    person_q = str(person or "").strip()
    person_l = person_q.lower()

    raw_all = insights.list_commitments(status="all", days=days)
    visible: list[dict[str, Any]] = []
    for item in raw_all.get("items") or []:
        mid = str(item.get("mid") or "")
        meta = _safe_get_meta(mid)
        if _is_blocked(meta, exclude_private):
            continue
        if person_l:
            who_l = str(item.get("who") or "").lower()
            text_l = str(item.get("text") or "").lower()
            spks_l = [s.lower() for s in _named_speakers(meta or {})]
            if person_l not in who_l and person_l not in text_l and not any(person_l in s for s in spks_l):
                continue
        visible.append(item)

    open_items = [x for x in visible if not x.get("done")]
    done_items = [x for x in visible if x.get("done")]
    counts = {
        "open": len(open_items),
        "done": len(done_items),
        "total": len(visible),
        "mine": sum(1 for x in open_items if x.get("direction") == "mine"),
        "theirs": sum(1 for x in open_items if x.get("direction") == "theirs"),
        "overdue": sum(1 for x in open_items if x.get("overdue")),
    }
    if status == "open":
        out = open_items
    elif status == "done":
        out = done_items
    else:
        out = open_items + done_items
    return {"status": status, "days": days, "person": person_q, "counts": counts, "items": out}


def _list_saved_daily_dates(exclude_private: bool) -> list[str]:
    ddir = _daily_dir()
    if not ddir.exists():
        return []
    dates: list[str] = []
    for p in ddir.iterdir():
        if not p.is_file() or p.suffix != ".json":
            continue
        stem = p.stem
        if not _DATE_RE.fullmatch(stem):
            continue
        rec = store.read_json(p)
        if not isinstance(rec, dict) or not str(rec.get("markdown") or "").strip():
            continue
        if _daily_summary_hidden(rec, stem, exclude_private):
            continue
        dates.append(stem)
    dates.sort(reverse=True)
    return dates


def _get_daily_summary_impl(date: str, exclude_private: bool) -> dict[str, Any]:
    req_date = _validate_ymd(date, "date") if str(date or "").strip() else ""
    ddir = _daily_dir()

    if req_date:
        target_date = req_date
    else:
        today = datetime.now().strftime("%Y-%m-%d")
        today_rec = store.read_json(ddir / f"{today}.json")
        today_has_summary = (
            isinstance(today_rec, dict)
            and bool(str(today_rec.get("markdown") or "").strip())
            and not _daily_summary_hidden(today_rec, today, exclude_private)
        )
        today_meetings = [m for m in store.list_by_date(today) if not _is_blocked(m, exclude_private)]
        if today_has_summary or today_meetings:
            target_date = today
        else:
            saved_dates = _list_saved_daily_dates(exclude_private)
            if saved_dates:
                target_date = saved_dates[0]
            else:
                visible_dates = [
                    str(m.get("created") or "")[:10]
                    for m in store.list_all()
                    if not _is_blocked(m, exclude_private) and _DATE_RE.fullmatch(str(m.get("created") or "")[:10])
                ]
                target_date = max(visible_dates) if visible_dates else today

    rec = store.read_json(ddir / f"{target_date}.json")
    if not isinstance(rec, dict) or _daily_summary_hidden(rec, target_date, exclude_private):
        rec = None

    markdown = str(rec.get("markdown") or "") if isinstance(rec, dict) else ""
    day_metas = [m for m in store.list_by_date(target_date) if not _is_blocked(m, exclude_private)]
    day_meetings = [_meeting_summary_row(m) for m in day_metas]

    return {
        "date": target_date,
        "has_summary": bool(markdown.strip()),
        "markdown": markdown,
        "summary_created": str(rec.get("created") or "") if isinstance(rec, dict) else "",
        "meeting_count": len(day_meetings),
        "meetings": day_meetings,
    }


def _get_weekly_digest_impl(end_date: str, exclude_private: bool) -> dict[str, Any]:
    end_ymd = _validate_ymd(end_date, "end_date") if str(end_date or "").strip() else ""
    data = insights.collect_week_data(end_ymd or None)
    if exclude_private:
        had_blocked_meeting = False
        kept_meetings: list[dict[str, Any]] = []
        total_s = 0.0
        for m in data.get("meetings") or []:
            meta = _safe_get_meta(str(m.get("id") or ""))
            if not meta or _is_blocked(meta, True):
                if _is_blocked(meta, True):
                    had_blocked_meeting = True
                continue
            kept_meetings.append(m)
            total_s += _duration_s(meta)
        kept_todos = [
            t for t in (data.get("todos") or [])
            if not _is_blocked(_safe_get_meta(str(t.get("mid") or "")), True)
        ]
        kept_commits = [
            c for c in (data.get("commitments") or [])
            if not _is_blocked(_safe_get_meta(str(c.get("mid") or "")), True)
        ]
        ddir = _daily_dir()
        had_hidden_daily = False
        kept_daily = []
        for ds in data.get("daily_summaries") or []:
            dstr = str(ds.get("date") or "")
            rec = store.read_json(ddir / f"{dstr}.json")
            if _daily_summary_hidden(rec, dstr, True):
                had_hidden_daily = True
            else:
                kept_daily.append(ds)
        active_days = len({str(m.get("created") or "")[:10] for m in kept_meetings if m.get("created")})
        data = {
            **data,
            "meeting_count": len(kept_meetings),
            "active_days": active_days,
            "total_s": round(total_s, 1),
            "meetings": kept_meetings,
            "daily_summaries": kept_daily,
            "todos": kept_todos,
            "commitments": kept_commits,
        }
        if had_blocked_meeting or had_hidden_daily or (not kept_meetings and not kept_daily):
            data["report"] = None

    if data.get("meetings") or data.get("daily_summaries"):
        data["draft_markdown"] = insights.build_local_weekly_markdown(data)
    else:
        data["draft_markdown"] = ""
    return data


def _trim_context_pack(pack: dict[str, Any], max_chars: int) -> dict[str, Any]:
    def measure() -> int:
        return len(json.dumps(pack, ensure_ascii=False, indent=2))

    if measure() <= max_chars:
        return pack

    pack["budget"]["truncated"] = True

    # Phase 1: shorten daily / weekly markdown excerpts first
    for ds in pack.get("daily_context") or []:
        if len(ds.get("markdown", "")) > 320:
            ds["markdown"] = ds["markdown"][:320] + "…"
    wk = pack.get("weekly_context")
    if isinstance(wk, dict) and len(wk.get("excerpt", "")) > 320:
        wk["excerpt"] = wk["excerpt"][:320] + "…"
    if measure() <= max_chars:
        return pack

    # Phase 2: trim daily_context / weekly_context completely if still tight
    while pack.get("daily_context") and measure() > max_chars:
        pack["daily_context"].pop()
    if measure() <= max_chars:
        return pack
    if pack.get("weekly_context") is not None and measure() > max_chars:
        pack["weekly_context"] = None
    if measure() <= max_chars:
        return pack

    # Phase 3: round-robin pop tails of lower-priority lists while preserving at least 1 top item when possible
    list_keys = ["related_projects", "open_todos", "open_commitments", "quotes", "meetings"]
    changed = True
    while measure() > max_chars and changed:
        changed = False
        for k in list_keys:
            items = pack.get(k)
            min_keep = 1 if k in ("meetings", "quotes") else 0
            if isinstance(items, list) and len(items) > min_keep:
                items.pop()
                changed = True
                if measure() <= max_chars:
                    return pack

    # Phase 4: tighten text fields for very small budgets
    for q in pack.get("quotes") or []:
        if len(q.get("quote", "")) > 80:
            q["quote"] = q["quote"][:80] + "…"
    for m in pack.get("meetings") or []:
        if len(m.get("brief", "")) > 60:
            m["brief"] = m["brief"][:60] + "…"
    if measure() <= max_chars:
        return pack

    # Phase 5: final hard cap if budget is extremely tiny
    for k in ("quotes", "meetings"):
        items = pack.get(k)
        while isinstance(items, list) and items and measure() > max_chars:
            items.pop()
    return pack


def _build_context_pack_impl(
    query: str,
    person: str,
    days: int,
    max_chars: int,
    exclude_private: bool,
) -> dict[str, Any]:
    q = str(query or "").strip()
    ql = q.lower()
    q_tokens = {t.lower() for t in relations._extract_tokens(q)} if q else set()
    p_name = str(person or "").strip()
    p_l = p_name.lower()
    days = max(0, min(365, days))
    max_chars = max(800, min(60000, max_chars))

    cutoff_ymd = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d") if days > 0 else ""

    all_metas = [
        m for m in store.list_all()
        if m.get("id")
        and not _is_blocked(m, exclude_private)
        and (not cutoff_ymd or not str(m.get("created") or "")[:10] or str(m.get("created") or "")[:10] >= cutoff_ymd)
    ]

    # Collect scored quotes & matched meetings
    meeting_scores: dict[str, float] = {}
    quote_candidates: list[dict[str, Any]] = []
    seen_quotes: set[tuple[str, str, str]] = set()

    def push_quote(meta: dict, ts: str, speaker: str, quote_txt: str, score: float) -> None:
        mid = str(meta.get("id") or "")
        qtxt = re.sub(r"\s+", " ", str(quote_txt or "")).strip()[:220]
        if not qtxt:
            return
        ts_clean = str(ts or "00:00").strip("[] ")
        key = (mid, ts_clean, qtxt[:48])
        if key in seen_quotes:
            return
        seen_quotes.add(key)
        title = str(meta.get("title") or mid)
        date_s = str(meta.get("created") or "")[:10]
        who = str(speaker or "").strip()
        quote_candidates.append({
            "mid": mid,
            "meeting_title": title,
            "date": date_s,
            "ts": f"[{ts_clean}]",
            "speaker": who,
            "quote": qtxt,
            "citation": f"《{title}》[{date_s} {ts_clean}]" + (f" {who}" if who else ""),
            "score": round(float(score), 3),
        })

    # Seed from insights.retrieve_global_context when query is provided
    if q and hasattr(insights, "retrieve_global_context"):
        try:
            g_hits = insights.retrieve_global_context(q, limit=16)
        except Exception:  # noqa: BLE001
            g_hits = []
        for c in g_hits:
            mid = str(c.get("mid") or "")
            meta = _safe_get_meta(mid)
            if not meta or _is_blocked(meta, exclude_private):
                continue
            created = str(meta.get("created") or "")
            if cutoff_ymd and created[:10] and created[:10] < cutoff_ymd:
                continue
            sc = float(c.get("score") or 0.0)
            if p_l:
                spks = [s.lower() for s in _named_speakers(meta)]
                if any(p_l in s for s in spks) or p_l in str(c.get("speaker") or "").lower():
                    sc += 3.0
            meeting_scores[mid] = max(meeting_scores.get(mid, 0.0), sc)
            push_quote(meta, str(c.get("ts") or "00:00"), str(c.get("speaker") or ""), str(c.get("quote") or ""), sc)

    # Scan candidate meetings for query/person/recency scoring and verbatim quotes
    for idx, meta in enumerate(all_metas):
        mid = str(meta.get("id") or "")
        title = str(meta.get("title") or mid)
        brief = str(meta.get("brief") or "")
        tags = [str(t) for t in (meta.get("tags") or []) if str(t).strip()]
        spks = _named_speakers(meta)
        spks_l = [s.lower() for s in spks]

        person_match = bool(p_l and any(p_l in s for s in spks_l))
        query_score = 0.0
        if q:
            if ql in title.lower():
                query_score += 5.0
            if brief and ql in brief.lower():
                query_score += 3.5
            if any(ql in t.lower() for t in tags):
                query_score += 3.0
            if q_tokens:
                tb_toks = {t.lower() for t in relations._extract_tokens(f"{title} {brief} {' '.join(tags)}")}
                ov = len(q_tokens & tb_toks)
                if ov:
                    query_score += 1.5 * ov

        paras = _load_paras(mid)
        mn = store.load(mid, "minutes.json")
        md_txt = str(mn.get("markdown") or "") if isinstance(mn, dict) else ""

        if p_l and not person_match:
            if p_l in title.lower() or p_l in md_txt.lower():
                person_match = True

        # Score paragraphs for verbatim quotes
        per_m_quotes: list[tuple[float, str, str, str]] = []
        for p in paras:
            txt = _para_text(p).strip()
            if len(txt) < 4:
                continue
            tl = txt.lower()
            who = _speaker_label(meta, p)
            ts = _fmt_ts(p.get("start", 0))
            psc = 0.0
            if q:
                if ql in tl:
                    psc += 6.0
                elif q_tokens:
                    p_toks = {t.lower() for t in relations._extract_tokens(txt)}
                    ov = len(q_tokens & p_toks)
                    if ov:
                        psc += 2.5 * ov / math.sqrt(max(1, len(p_toks)))
                    else:
                        sub = sum(1 for t in q_tokens if len(t) >= 2 and t in tl)
                        psc += 1.2 * sub
            if p_l and (p_l in who.lower() or p_l in tl):
                psc += 3.0 if p_l in who.lower() else 1.8
            if not q and not p_l and idx < 5 and len(per_m_quotes) < 2:
                psc = max(1.0, 2.0 - idx * 0.2)
            if psc > 0:
                per_m_quotes.append((psc + (1.5 if person_match and q else 0.0), ts, who, txt))

        per_m_quotes.sort(key=lambda x: -x[0])
        for psc, ts, who, txt in per_m_quotes[:2]:
            push_quote(meta, ts, who, txt, psc)
            query_score = max(query_score, psc)

        if q and md_txt and not per_m_quotes:
            md_l = md_txt.lower()
            pos = md_l.find(ql)
            if pos >= 0:
                s0 = max(0, pos - 30)
                push_quote(meta, "00:00", "纪要", md_txt[s0 : pos + len(q) + 90], 3.5 + (2.0 if person_match else 0.0))
                query_score = max(query_score, 3.5)

        total_score = query_score
        if person_match:
            total_score += 4.0 if not q else (2.5 if query_score > 0 else 1.5)
        if not q and not p_l:
            total_score = max(0.5, 5.0 - idx * 0.2)

        if total_score > 0:
            meeting_scores[mid] = max(meeting_scores.get(mid, 0.0), round(total_score, 3))

    meta_by_id = {str(m.get("id")): m for m in all_metas}
    ranked_mids = sorted(
        meeting_scores.keys(),
        key=lambda mid: (meeting_scores[mid], str(meta_by_id[mid].get("created") or "")),
        reverse=True,
    )[:10]
    matched_mid_set = set(ranked_mids)

    matched_meetings = [
        {
            "id": mid,
            "title": str(meta_by_id[mid].get("title") or mid),
            "created": str(meta_by_id[mid].get("created") or ""),
            "brief": str(meta_by_id[mid].get("brief") or ""),
            "tags": list(meta_by_id[mid].get("tags") or []),
            "speakers": _named_speakers(meta_by_id[mid]),
        }
        for mid in ranked_mids
    ]

    quote_candidates.sort(key=lambda x: (float(x["score"]), x["date"]), reverse=True)
    top_quotes = quote_candidates[:10]

    # Related projects (pass days=0 through for unlimited range)
    proj_resp = _list_projects_filtered(days=days, limit=12, exclude_private=exclude_private)
    related_projects: list[dict[str, Any]] = []
    for pr in proj_resp.get("projects") or []:
        pr_mids = {str(m.get("id") or "") for m in (pr.get("meetings") or [])}
        pr_blob = " ".join([str(pr.get("name") or ""), *(str(k) for k in (pr.get("keywords") or [])), *(str(p) for p in (pr.get("participants") or []))]).lower()
        relevant = not q and not p_l
        if pr_mids & matched_mid_set:
            relevant = True
        elif q and (ql in pr_blob or any(t in pr_blob for t in q_tokens)):
            relevant = True
        elif p_l and any(p_l in str(pt).lower() for pt in (pr.get("participants") or [])):
            relevant = True
        if relevant:
            related_projects.append({
                "id": pr["id"],
                "name": pr["name"],
                "keywords": pr.get("keywords") or [],
                "meeting_count": pr.get("meeting_count") or 0,
                "latest_at": pr.get("latest_at") or "",
                "participants": pr.get("participants") or [],
            })
    related_projects = related_projects[:6]

    # Open commitments (pass days=0 through for unlimited range)
    comm_resp = _list_commitments_filtered(status="open", days=days, person=p_name, exclude_private=exclude_private)
    open_commitments: list[dict[str, Any]] = []
    for c in comm_resp.get("items") or []:
        if q:
            c_blob = f"{c.get('text', '')} {c.get('meeting_title', '')} {c.get('who', '')}".lower()
            if str(c.get("mid") or "") not in matched_mid_set and ql not in c_blob and not any(t in c_blob for t in q_tokens):
                continue
        open_commitments.append({
            "id": c.get("id"),
            "mid": c.get("mid"),
            "meeting_title": c.get("meeting_title"),
            "created": c.get("created"),
            "who": c.get("who"),
            "direction": c.get("direction"),
            "text": c.get("text"),
            "due_hint": c.get("due_hint") or "",
            "ts": f"[{c.get('ts') or '00:00'}]",
            "overdue": bool(c.get("overdue")),
        })
    open_commitments = open_commitments[:12]

    # Open todos
    todo_resp = _list_todos_filtered(status="open", person=p_name, limit=100, exclude_private=exclude_private)
    open_todos: list[dict[str, Any]] = []
    for t in todo_resp.get("items") or []:
        t_created = str(t.get("meeting_created") or "")
        if cutoff_ymd and t_created[:10] and t_created[:10] < cutoff_ymd:
            continue
        if q:
            t_blob = f"{t.get('text', '')} {t.get('meeting_title', '')}".lower()
            if str(t.get("mid") or "") not in matched_mid_set and ql not in t_blob and not any(t_tok in t_blob for t_tok in q_tokens):
                continue
        open_todos.append({
            "mid": t.get("mid"),
            "meeting_title": t.get("meeting_title"),
            "meeting_created": t_created,
            "text": t.get("text"),
            "ts": f"[{t['ts']}]" if t.get("ts") else "",
            "speakers": t.get("speakers") or [],
        })
    open_todos = open_todos[:12]

    # Recent daily context
    matched_dates = {str(m["created"])[:10] for m in matched_meetings if m.get("created")}
    daily_context: list[dict[str, Any]] = []
    ddir = _daily_dir()
    for dstr in _list_saved_daily_dates(exclude_private):
        if cutoff_ymd and dstr < cutoff_ymd:
            continue
        rec = store.read_json(ddir / f"{dstr}.json")
        if not isinstance(rec, dict) or not str(rec.get("markdown") or "").strip():
            continue
        md = str(rec["markdown"]).strip()
        md_l = md.lower()
        hit = (not q and not p_l) or (dstr in matched_dates)
        if not hit and q and (ql in md_l or any(tok in md_l for tok in q_tokens)):
            hit = True
        if not hit and p_l and p_l in md_l:
            hit = True
        if hit:
            daily_context.append({"date": dstr, "markdown": md[:900]})
            if len(daily_context) >= 3:
                break

    # Recent weekly context
    wk_data = _get_weekly_digest_impl("", exclude_private)
    weekly_context: dict[str, Any] | None = None
    if wk_data.get("meeting_count") or wk_data.get("daily_summaries") or wk_data.get("report"):
        rep = wk_data.get("report")
        excerpt = str(rep.get("markdown") or "") if isinstance(rep, dict) else str(wk_data.get("draft_markdown") or "")
        weekly_context = {
            "week_id": wk_data["week_id"],
            "start_date": wk_data["start_date"],
            "end_date": wk_data["end_date"],
            "meeting_count": wk_data["meeting_count"],
            "active_days": wk_data["active_days"],
            "excerpt": excerpt[:900],
        }

    pack: dict[str, Any] = {
        "query": q,
        "person": p_name,
        "days": days,
        "meetings": matched_meetings,
        "quotes": top_quotes,
        "related_projects": related_projects,
        "open_commitments": open_commitments,
        "open_todos": open_todos,
        "daily_context": daily_context,
        "weekly_context": weekly_context,
        "budget": {"max_chars": max_chars, "truncated": False},
    }
    return _trim_context_pack(pack, max_chars)


def handle_tool_call(name: str, args: dict[str, Any], exclude_private: bool = False) -> dict[str, Any]:
    if not isinstance(args, dict):
        args = {}

    if name == "list_meetings":
        limit = _int_arg(args, "limit", 20, 1, 100)
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
            items.append(_meeting_summary_row(m))
            if len(items) >= limit:
                break
        return {"count": len(items), "meetings": items}

    if name == "search_meetings":
        q = str(args.get("query") or "").strip()
        limit = _int_arg(args, "limit", 10, 1, 50)
        return _search_meetings_impl(q, limit=limit, exclude_private=exclude_private)

    if name == "get_meeting":
        mid = str(args.get("mid") or "").strip()
        meta = _safe_get_meta(mid)
        if not meta or _is_blocked(meta, exclude_private):
            raise ValueError(f"找不到会议或已设为隐私：{mid}")
        mn = store.load(mid, "minutes.json")
        md_dir = store.mdir(mid)
        notes_p = md_dir / "notes.txt"
        if not notes_p.exists() and (md_dir / "notes.md").exists():
            notes_p = md_dir / "notes.md"
        notes = notes_p.read_text(encoding="utf-8", errors="ignore") if notes_p.exists() else ""
        marks = store.load(mid, "marks.json") or []
        out: dict[str, Any] = {
            "meta": {
                "id": meta.get("id"),
                "title": meta.get("title"),
                "created": meta.get("created"),
                "source": meta.get("source"),
                "duration_s": _duration_s(meta),
                "brief": str(meta.get("brief") or ""),
                "tags": list(meta.get("tags") or []),
                "speakers": meta.get("speakers") or {},
            },
            "minutes_markdown": mn.get("markdown", "") if isinstance(mn, dict) else "",
            "notes": notes,
            "marks": marks,
        }
        if args.get("include_transcript", True):
            max_chars = _int_arg(args, "max_chars", 24000, 1000, 100000)
            paras = _load_paras(mid)
            lines = []
            total = 0
            truncated = False
            for p in paras:
                who = _speaker_label(meta, p)
                txt = _para_text(p)
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
        meta = _safe_get_meta(mid)
        if not meta or _is_blocked(meta, exclude_private):
            raise ValueError(f"找不到会议或已设为隐私：{mid}")
        limit = _int_arg(args, "limit", 5, 1, 20)
        items = relations.related_meetings(mid, limit=min(20, limit * 2) if exclude_private else limit)
        if exclude_private:
            items = [x for x in items if not _is_blocked(_safe_get_meta(str(x.get("id") or "")), True)][:limit]
        return {"mid": mid, "items": items}

    if name == "get_person_history":
        pname = str(args.get("name") or "").strip()
        if not pname:
            return {"people": _list_people_filtered(exclude_private)}
        return _person_history_filtered(pname, exclude_private)

    if name == "list_todos":
        status = str(args.get("status") or "open")
        person = str(args.get("person") or "")
        limit = _int_arg(args, "limit", 100, 1, 500)
        return _list_todos_filtered(status=status, person=person, limit=limit, exclude_private=exclude_private)

    if name == "build_context_pack":
        query = str(args.get("query") or "")
        person = str(args.get("person") or "")
        days = _int_arg(args, "days", 30, 0, 365)
        max_chars = _int_arg(args, "max_chars", 12000, 800, 60000)
        return _build_context_pack_impl(query=query, person=person, days=days, max_chars=max_chars, exclude_private=exclude_private)

    if name == "list_projects":
        days = _int_arg(args, "days", 30, 0, 365)
        limit = _int_arg(args, "limit", 12, 1, 30)
        return _list_projects_filtered(days=days, limit=limit, exclude_private=exclude_private)

    if name == "list_commitments":
        status = str(args.get("status") or "open")
        days = _int_arg(args, "days", 14, 0, 365)
        person = str(args.get("person") or "")
        return _list_commitments_filtered(status=status, days=days, person=person, exclude_private=exclude_private)

    if name == "get_daily_summary":
        date = str(args.get("date") or "")
        return _get_daily_summary_impl(date=date, exclude_private=exclude_private)

    if name == "get_weekly_digest":
        end_date = str(args.get("end_date") or "")
        return _get_weekly_digest_impl(end_date=end_date, exclude_private=exclude_private)

    raise ValueError(f"未知工具：{name}")


def handle_prompt_get(name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    a = args if isinstance(args, dict) else {}
    cite_rule = (
        "写作规范：\n"
        "- 所有关键事实与原话证据请标注来源：《会议标题》[YYYY-MM-DD MM:SS] 说话人。\n"
        "- 明确区分「已确认决议」与「未闭环承诺/待办/风险」，不要编造未在记录中出现的结论。"
    )

    if name == "pre-meeting-brief":
        topic = str(a.get("topic") or "").strip()
        if not topic:
            raise ValueError("缺少必填参数：topic")
        person = str(a.get("person") or "").strip()
        days = str(a.get("days") or "30").strip()
        person_part = f"、重点参会人「{person}」" if person else ""
        person_arg = f', person="{person}"' if person else ""
        text = (
            f"请为主题「{topic}」{person_part}准备一份结构化会前简报（回溯近 {days} 天）。\n\n"
            "推荐调用步骤：\n"
            f'1. 先调用 `build_context_pack(query="{topic}"{person_arg}, days={days})` 一次拉齐匹配会议、原话引用、关联项目、未完成承诺与待办。\n'
            + (f'2. 调用 `get_person_history(name="{person}")` 补充与 {person} 的历史协作脉络。\n' if person else "")
            + "3. 对最关键的 1-2 场会议调用 `get_meeting(mid=...)` 核对完整纪要与原话上下文。\n\n"
            "输出结构：1) 背景与最近进展 2) 已确认决议 3) 未完成承诺与待办（标明负责人与超期状态）4) 遗留分歧/风险 5) 本次会议建议议程与需确认问题。\n\n"
            f"{cite_rule}"
        )
        return {
            "description": f"为「{topic}」生成会前简报",
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}],
        }

    if name == "topic-deep-dive":
        topic = str(a.get("topic") or "").strip()
        if not topic:
            raise ValueError("缺少必填参数：topic")
        days = str(a.get("days") or "60").strip()
        text = (
            f"请对专题/项目「{topic}」做一次深度脉络复盘（回溯近 {days} 天）。\n\n"
            "推荐调用步骤：\n"
            f'1. 先调用 `build_context_pack(query="{topic}", days={days})` 和 `list_projects(days={days})` 定位专题全部关联会议。\n'
            f'2. 如需补充长尾提及，调用 `search_meetings(query="{topic}")`；对关键里程碑会议调用 `get_meeting(mid=...)` 与 `get_related_meetings(mid=...)`。\n'
            "3. 交叉核对 `list_commitments` 与 `list_todos`，找出未闭环项。\n\n"
            "输出结构：1) 专题核心现状 2) 按时间线演进的关键节点与决策变化 3) 关键原话证据 4) 未解决风险与卡点 5) 后续建议动作。\n\n"
            f"{cite_rule}"
        )
        return {
            "description": f"对专题「{topic}」进行时间线深度复盘",
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}],
        }

    if name == "person-sync-prep":
        person = str(a.get("person") or "").strip()
        if not person:
            raise ValueError("缺少必填参数：person")
        days = str(a.get("days") or "45").strip()
        text = (
            f"请为与「{person}」的同步沟通 / 1v1 准备一份交集与跟进清单（回溯近 {days} 天）。\n\n"
            "推荐调用步骤：\n"
            f'1. 调用 `build_context_pack(person="{person}", days={days})` 获取近期共同会议、原话引用、相关项目与待跟进项。\n'
            f'2. 调用 `get_person_history(name="{person}")` 查看全部历史交集、高频话题与共同参会人。\n'
            f'3. 调用 `list_commitments(status="open", days={days}, person="{person}")` 和 `list_todos(status="open", person="{person}")` 核对双方未闭环承诺。\n\n'
            "输出结构：1) 最近一次沟通结论 2) 我方答应对方尚未完成的事项 3) 等待对方反馈/交付的事项 4) 共同推进中的项目现状 5) 本次沟通建议清单。\n\n"
            f"{cite_rule}"
        )
        return {
            "description": f"为与「{person}」的同步沟通准备材料",
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}],
        }

    if name == "weekly-context-review":
        end_date = str(a.get("end_date") or "").strip()
        if end_date:
            _validate_ymd(end_date, "end_date")
        end_arg = f'end_date="{end_date}"' if end_date else ""
        label = f"（截止日期所在周：{end_date}）" if end_date else "（本周）"
        text = (
            f"请生成一份结构化的周度工作复盘与上下文总结{label}。\n\n"
            "推荐调用步骤：\n"
            f"1. 调用 `get_weekly_digest({end_arg})` 获取本周全部会议、每日总结、待办、承诺与已有周报草稿。\n"
            "2. 结合 `list_projects(days=14)` 与 `list_commitments(status=\"open\", days=14)` 识别跨会项目进展和超期风险。\n"
            "3. 如需核对某天细节，调用 `get_daily_summary(date=...)` 或 `get_meeting(mid=...)`。\n\n"
            "输出结构：1) 本周核心产出与关键决议 2) 按项目归类的进展 3) 已完成 vs 遗留待办与超期承诺 4) 下周优先关注事项。\n\n"
            f"{cite_rule}"
        )
        return {
            "description": f"生成周度上下文复盘{label}",
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}],
        }

    raise ValueError(f"未知 Prompt：{name}")


def handle_resource_read(uri: str, exclude_private: bool = False) -> dict[str, Any]:
    target = str(uri or "").strip()
    if target == "meeting://recent":
        data = handle_tool_call("list_meetings", {"limit": 20}, exclude_private=exclude_private)
    elif target == "meeting://commitments/open":
        data = handle_tool_call("list_commitments", {"status": "open", "days": 30}, exclude_private=exclude_private)
    elif target == "meeting://todos/open":
        data = handle_tool_call("list_todos", {"status": "open", "limit": 100}, exclude_private=exclude_private)
    elif target == "meeting://projects/active":
        data = handle_tool_call("list_projects", {"days": 30, "limit": 12}, exclude_private=exclude_private)
    else:
        raise ValueError(f"未知资源 URI：{target}")

    return {
        "contents": [
            {
                "uri": target,
                "mimeType": "application/json",
                "text": json.dumps(data, ensure_ascii=False, indent=2),
            }
        ]
    }


def handle_rpc(msg: Any, exclude_private: bool = False) -> dict[str, Any] | None:
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request: expected JSON object"}}

    has_id = "id" in msg
    req_id = msg.get("id")
    method = msg.get("method")
    if not isinstance(method, str) or not method.strip():
        if not has_id:
            return None
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32600, "message": "Invalid Request: missing method"}}

    if method == "notifications/initialized" or ((not has_id or req_id is None) and method.startswith("notifications/")):
        return None

    raw_params = msg.get("params")
    if raw_params is not None and not isinstance(raw_params, dict):
        if not has_id:
            return None
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "Invalid params: expected JSON object"}}
    params = raw_params or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}, "prompts": {}, "resources": {}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        tname = str(params.get("name") or "")
        if tname not in _TOOL_NAMES:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Unknown tool: {tname}"}}
        raw_targs = params.get("arguments")
        if raw_targs is not None and not isinstance(raw_targs, dict):
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "Invalid params: arguments must be an object"}}
        targs = raw_targs or {}
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
        except Exception as e:  # noqa: BLE001
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                    "isError": True,
                },
            }
    if method == "prompts/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": PROMPTS}}
    if method == "prompts/get":
        pname = str(params.get("name") or "")
        raw_pargs = params.get("arguments")
        if raw_pargs is not None and not isinstance(raw_pargs, dict):
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": "Invalid params: arguments must be an object"}}
        pargs = raw_pargs or {}
        try:
            res = handle_prompt_get(pname, pargs)
            return {"jsonrpc": "2.0", "id": req_id, "result": res}
        except ValueError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": str(e)}}
        except Exception as e:  # noqa: BLE001
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": f"Internal error: {e}"}}
    if method == "resources/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": RESOURCES}}
    if method == "resources/read":
        uri = str(params.get("uri") or "")
        try:
            res = handle_resource_read(uri, exclude_private=exclude_private)
            return {"jsonrpc": "2.0", "id": req_id, "result": res}
        except ValueError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32002, "message": str(e)}}
        except Exception as e:  # noqa: BLE001
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": f"Internal error: {e}"}}
    if not has_id:
        return None
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
            try:
                resp = handle_rpc(msg, exclude_private=ns.exclude_private)
            except Exception as e:  # noqa: BLE001
                err_id = msg.get("id") if isinstance(msg, dict) else None
                resp = {"jsonrpc": "2.0", "id": err_id, "error": {"code": -32603, "message": f"Internal error: {e}"}}
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
