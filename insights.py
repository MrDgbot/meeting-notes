"""智能摘要、承诺雷达、跨会闪问与周报草稿引擎（全部基于 store.DATA 动态解析，支持单测隔离）。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import AsyncIterator

import llm
import relations
import rsi_events
import store

_AUTO_TITLE_RE = re.compile(r"^(?:自动记录\s+\d{1,2}:\d{2}|会议\s+\d{2}-\d{2}\s+\d{1,2}:\d{2}|新会议|未命名会议)$")
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
_CLAUSE_SPLIT_RE = re.compile(r"[。！？!?；;\n]+")

_MINE_COMMIT_RES = (
    re.compile(
        r"(?:我和?大家|我这边|咱们?|我自己|我)"
        r"(?:今天|明天|后天|今晚|周五前|周末前?|本周[一二三四五]?|下周[一二三四五]?|晚点|待会|一会儿?|回头|马上|稍后|下午|上午|晚上)?"
        r"[^。！？!?；;\n]{1,30}?"
        r"(?:发你|发给你|发大家|发出来|发一下|整理完|整理一下|整理好|汇总一下|梳理一下|输出|定一下|确认好|确认一下|跟进一下|推进一下|拉个?群|约个?会|提交|改完|改一下|修一下|补上|排查一下?|测试一下|验证一下|上线|核对一下?)"
    ),
    re.compile(r"(?:我来|交给我来?|包在我身上|由我来|我负责|我这边来)[^。！？!?；;\n]{2,26}"),
)

_THEIRS_COMMIT_RES = (
    re.compile(
        r"(?:请你?|麻烦你?|你这边|他那边|她那边|对方|[A-Za-z0-9\u4e00-\u9fff]{1,6}(?:总|哥|姐|老师))"
        r"(?:今天|明天|后天|周五前|周末前?|下周|晚点|待会|回头|尽快)?"
        r"[^。！？!?；;\n]{0,18}?"
        r"(?:负责|跟进一下?|发一下?|发我|给我|确认一下?|定一下|出一版|安排一下|帮看下|看一下|反馈一下|同步一下|协调一下|联系一下)"
    ),
)

_DUE_HINT_RE = re.compile(
    r"(今天|今晚|明天|后天|周五前|周[一二三四五六日]前?|本周内?|下周[一二三四五]?|月底前|待会|一会儿?|晚点|稍后|马上)"
)

_FILLER_LEAD_RE = re.compile(r"^(?:那个|就是|然后|呃|嗯|其实|我说一下|那个啥|好吧|对对对)[，,\s]*")


def _daily_dir() -> Path:
    return store.DATA / "daily"


def _commitments_path(mid: str) -> Path:
    return store.mdir(mid) / "commitments.json"


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _fmt_ts(ms: int) -> str:
    s = max(0, int((ms or 0) // 1000))
    h, m, x = s // 3600, (s // 60) % 60, s % 60
    return f"{h}:{m:02d}:{x:02d}" if h else f"{m:02d}:{x:02d}"


def _ts_to_ms(label: str) -> int:
    parts = [int(p) for p in re.findall(r"\d+", str(label or ""))]
    if len(parts) == 2:
        return (parts[0] * 60 + parts[1]) * 1000
    if len(parts) == 3:
        return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
    return 0


def _ndjson(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


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


def _load_paras_for_meeting(mid: str) -> list[dict]:
    tr = store.load(mid, "transcript.json")
    if isinstance(tr, dict) and tr.get("paragraphs"):
        return [p for p in tr["paragraphs"] if isinstance(p, dict) and str(p.get("text") or "").strip()]
    live = store.load(mid, "live.json")
    if isinstance(live, list):
        out: list[dict] = []
        for idx, x in enumerate(live):
            if not isinstance(x, dict) or not str(x.get("text") or "").strip():
                continue
            out.append({
                "start": int(x.get("start") or 0),
                "end": int(x.get("end") or 0),
                "spk": int(x["ch"]) if isinstance(x.get("ch"), int) else -1,
                "ch": x.get("ch"),
                "text": str(x["text"]),
                "_idx": idx,
            })
        return out
    return []


def _commitment_id(mid: str, direction: str, start_ms: int, text: str) -> str:
    norm = re.sub(r"\s+", "", text)
    raw = f"{mid}|{direction}|{start_ms // 1000}|{norm}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def extract_commitments_rules(meta: dict, paras: list[dict]) -> list[dict]:
    """从口语转写中高置信抽取「我答应的 / 对方答应的」口头承诺。"""
    mid = str(meta.get("id") or "")
    created = str(meta.get("created") or "")
    title = str(meta.get("title") or mid)
    out: list[dict] = []
    seen_norm: set[tuple[str, str]] = set()

    for p in paras:
        text = str(p.get("text") or "").strip()
        if len(text) < 5:
            continue
        start_ms = int(p.get("start") or 0)
        ts = _fmt_ts(start_ms)
        who = _speaker_label(meta, p)

        for clause_raw in _CLAUSE_SPLIT_RE.split(text):
            clause = _FILLER_LEAD_RE.sub("", clause_raw.strip())
            if len(clause) < 5:
                continue
            matched_dir: str | None = None
            matched_text = clause

            for pat in _MINE_COMMIT_RES:
                m = pat.search(clause)
                if m:
                    matched_dir = "mine"
                    matched_text = m.group(0).strip(" ，,：:")
                    break

            if matched_dir is None:
                for pat in _THEIRS_COMMIT_RES:
                    m = pat.search(clause)
                    if m:
                        matched_dir = "theirs"
                        matched_text = m.group(0).strip(" ，,：:")
                        break

            if not matched_dir or len(matched_text) < 5:
                continue
            # 问句/反问通常是提问而不是明确承诺
            if "?" in clause_raw or "？" in clause_raw or re.search(r"(?:吗|呢|是不是|对不对|行不行)$", matched_text):
                continue
            if who == "对方" and matched_dir == "mine":
                matched_dir = "theirs"
            norm_key = (matched_dir, re.sub(r"[，,、\s]+", "", matched_text)[:28])
            if norm_key in seen_norm:
                continue
            seen_norm.add(norm_key)
            due_m = _DUE_HINT_RE.search(matched_text)
            cid = _commitment_id(mid, matched_dir, start_ms, matched_text)
            out.append({
                "id": cid,
                "mid": mid,
                "meeting_title": title,
                "created": created,
                "who": who or ("我" if matched_dir == "mine" else "对方"),
                "direction": matched_dir,
                "text": matched_text[:80],
                "due_hint": due_m.group(1) if due_m else "",
                "ts": ts,
                "start_ms": start_ms,
                "done": False,
                "dismissed": False,
                "source": "rule",
            })
            if len(out) >= 12:
                return out
    return out


def _clean_title(raw: str) -> str:
    s = re.sub(r"^[#\s\-*\"'「“]+|[\"'」”。！？!?.,\s]+$", "", str(raw or "").strip())
    if not s or _AUTO_TITLE_RE.match(s):
        return ""
    return s[:24]


def _clean_brief(raw: str) -> str:
    s = re.sub(r"\s+", " ", str(raw or "")).strip(" \"'「」“”")
    return s[:64]


def _clean_tags(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        t = re.sub(r"^[#\s\"'「“]+|[\"'」”。！？!?.,\s]+$", "", str(item or "").strip())
        if not (2 <= len(t) <= 12):
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
        if len(out) >= 3:
            break
    return out


def build_brief_messages(meta: dict, paras: list[dict]) -> list[dict]:
    lines: list[str] = []
    total_chars = 0
    for p in paras:
        txt = str(p.get("text") or "").strip()
        if not txt:
            continue
        ts = _fmt_ts(int(p.get("start") or 0))
        who = _speaker_label(meta, p)
        line = f"[{ts}] {who + '：' if who else ''}{txt}"
        lines.append(line)
        total_chars += len(line) + 1
        if total_chars >= 1800:
            break
    body = "\n".join(lines)[:2000]
    prompt = (
        "请根据下面这段中文会议/工作沟通转写，提炼非常精炼的元数据，只输出一个 JSON 对象，不要解释：\n"
        '{\n'
        '  "title": "8-14字具体主题标题，禁止写‘会议记录/自动记录’",\n'
        '  "brief": "1句话核心结论或推进事项（不超过40字）",\n'
        '  "tags": ["1到3个2-6字的主题标签或项目名"],\n'
        '  "commitments": [\n'
        '    {"who": "说话人或我/对方", "direction": "mine或theirs或team", "text": "具体答应做的事", "due_hint": "截止时间或空", "ts": "MM:SS"}\n'
        "  ]\n"
        "}\n"
        "注意：commitments 只收确实说出口的明确行动承诺，没有就返回 []。\n\n"
        f"转写内容：\n{body}"
    )
    return [
        {"role": "system", "content": "你是精炼准确的中文工作助手，只返回合法 JSON。"},
        {"role": "user", "content": prompt},
    ]


def parse_brief_json(raw: str) -> dict | None:
    s = str(raw or "").strip()
    if not s:
        return None
    m = _JSON_FENCE_RE.search(s)
    if m:
        s = m.group(1).strip()
    else:
        i0, i1 = s.find("{"), s.rfind("}")
        if i0 >= 0 and i1 > i0:
            s = s[i0 : i1 + 1]
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    title = _clean_title(obj.get("title") or "")
    brief = _clean_brief(obj.get("brief") or "")
    tags = _clean_tags(obj.get("tags"))
    raw_comm = obj.get("commitments") if isinstance(obj.get("commitments"), list) else []
    commitments: list[dict] = []
    for c in raw_comm[:10]:
        if not isinstance(c, dict):
            continue
        ct = str(c.get("text") or "").strip()
        if len(ct) < 4:
            continue
        direction = str(c.get("direction") or "team").strip().lower()
        if direction not in ("mine", "theirs", "team"):
            direction = "team"
        ts = str(c.get("ts") or "00:00").strip()
        commitments.append({
            "who": str(c.get("who") or "").strip()[:24],
            "direction": direction,
            "text": ct[:80],
            "due_hint": str(c.get("due_hint") or "").strip()[:20],
            "ts": ts,
            "start_ms": _ts_to_ms(ts),
            "source": "llm",
        })
    if not title and not brief and not tags and not commitments:
        return None
    return {"title": title, "brief": brief, "tags": tags, "commitments": commitments}


def local_brief_fallback(meta: dict, paras: list[dict]) -> dict:
    """无大模型或接口失败时的确定性本机摘要与标签抽取。"""
    prof = relations._meeting_profile(meta)
    display = prof.get("display") or {}
    terms = sorted((prof.get("terms") or {}).items(), key=lambda kv: -kv[1])
    tags: list[str] = []
    for k, _ in terms:
        lbl = str(display.get(k, k) or "").strip()
        if 2 <= len(lbl) <= 10 and not _AUTO_TITLE_RE.match(lbl):
            tags.append(lbl)
            if len(tags) >= 3:
                break

    first_sentence = ""
    for p in paras:
        txt = _FILLER_LEAD_RE.sub("", str(p.get("text") or "").strip())
        if len(txt) >= 8:
            first_sentence = re.split(r"[。！？!?]", txt)[0].strip()
            if len(first_sentence) >= 8:
                break
    if not first_sentence and paras:
        first_sentence = str(paras[0].get("text") or "").strip()

    title = ""
    if tags and first_sentence:
        head_tag = tags[0]
        if head_tag.lower() in first_sentence.lower():
            title = first_sentence[:18]
        else:
            title = f"{head_tag}：{first_sentence[:14]}"
    elif tags:
        title = " · ".join(tags[:2])
    elif first_sentence:
        title = first_sentence[:18]

    brief = first_sentence[:44] if first_sentence else ""
    return {
        "title": _clean_title(title),
        "brief": _clean_brief(brief),
        "tags": _clean_tags(tags),
        "commitments": extract_commitments_rules(meta, paras),
    }


def load_commitments(mid: str) -> list[dict] | None:
    raw = store.load(mid, "commitments.json")
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        return [x for x in raw["items"] if isinstance(x, dict)]
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    return None


def save_commitments(mid: str, items: list[dict]) -> None:
    store.save(mid, "commitments.json", {"updated_at": _now_iso(), "items": items})


def _merge_commitments(mid: str, meta: dict, incoming: list[dict]) -> list[dict]:
    existing = load_commitments(mid) or []
    by_id: dict[str, dict] = {str(x.get("id")): dict(x) for x in existing if x.get("id")}
    by_norm: dict[str, dict] = {}
    for x in existing:
        nk = re.sub(r"[，,、\s]+", "", str(x.get("text") or ""))[:24]
        if nk:
            by_norm[nk] = x

    created = str(meta.get("created") or "")
    mtitle = str(meta.get("title") or mid)
    merged: list[dict] = list(existing)

    for raw in incoming:
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        direction = str(raw.get("direction") or "team")
        start_ms = int(raw.get("start_ms") or _ts_to_ms(str(raw.get("ts") or "")))
        cid = str(raw.get("id") or _commitment_id(mid, direction, start_ms, text))
        nk = re.sub(r"[，,、\s]+", "", text)[:24]
        if cid in by_id or (nk and nk in by_norm):
            continue
        item = {
            "id": cid,
            "mid": mid,
            "meeting_title": mtitle,
            "created": created,
            "who": str(raw.get("who") or "").strip() or ("我" if direction == "mine" else "对方"),
            "direction": direction,
            "text": text[:80],
            "due_hint": str(raw.get("due_hint") or "").strip()[:20],
            "ts": str(raw.get("ts") or _fmt_ts(start_ms)),
            "start_ms": start_ms,
            "done": False,
            "dismissed": False,
            "source": str(raw.get("source") or "rule"),
        }
        by_id[cid] = item
        if nk:
            by_norm[nk] = item
        merged.append(item)

    # 同步刷新 meeting_title
    for x in merged:
        x["meeting_title"] = mtitle
        if not x.get("created"):
            x["created"] = created
    return merged


def apply_brief_to_meeting(mid: str, parsed: dict, *, lock_title: bool = True) -> dict:
    with store.locked():
        meta = store.get(mid)
        if not meta:
            return {}
        fields: dict = {"brief_updated": _now_iso()}
        brief = _clean_brief(parsed.get("brief") or "")
        tags = _clean_tags(parsed.get("tags"))
        title = _clean_title(parsed.get("title") or "")
        if brief:
            fields["brief"] = brief
        if tags:
            fields["tags"] = tags
        if title and meta.get("title_source") != "manual" and (
            meta.get("title_auto") or (lock_title and meta.get("title_source") == "local_brief")
        ):
            fields["title"] = title
            fields["title_auto"] = False
            fields["title_source"] = "auto_brief" if lock_title else "local_brief"
        updated_meta = store.update(mid, **fields) or meta
        merged = _merge_commitments(mid, updated_meta, parsed.get("commitments") or [])
        if merged or load_commitments(mid) is not None:
            save_commitments(mid, merged)
        return {"meta": updated_meta, "commitments": merged}


def _provider_usable(prov: dict | None) -> bool:
    if not isinstance(prov, dict) or not prov.get("base_url") or not prov.get("model"):
        return False
    return bool(prov.get("api_key") or llm.is_local_url(str(prov.get("base_url") or "")))


async def generate_brief(mid: str, prov: dict | None, paras: list[dict] | None = None) -> dict:
    meta = store.get(mid)
    if not meta:
        return {}
    if paras is None:
        paras = _load_paras_for_meeting(mid)
    if not paras:
        return {}

    parsed: dict | None = None
    mode = "local"
    if _provider_usable(prov):
        try:
            raw = await llm.chat(prov, build_brief_messages(meta, paras), temperature=0.2, max_tokens=700)
            parsed = parse_brief_json(raw)
            if parsed is not None:
                mode = "llm"
        except Exception:  # noqa: BLE001
            parsed = None

    if parsed is None:
        parsed = local_brief_fallback(meta, paras)
    else:
        # 把规则抽取的明确口头承诺一起补齐（已通过去重）
        rule_items = extract_commitments_rules(meta, paras)
        parsed["commitments"] = list(parsed.get("commitments") or []) + rule_items

    applied = apply_brief_to_meeting(mid, parsed, lock_title=(mode == "llm"))
    return {"mode": mode, **applied}


def list_commitments(status: str = "open", days: int = 14) -> dict:
    """汇总近 N 天内各场对话的口头承诺，供承诺雷达与首页待跟进展示。"""
    now_dt = datetime.now()
    cutoff_str = (now_dt - timedelta(days=max(1, days))).strftime("%Y-%m-%d") if days and days > 0 else ""
    all_items: list[dict] = []

    for meta in store.list_all():
        mid = str(meta.get("id") or "")
        created = str(meta.get("created") or "")
        if cutoff_str and created[:10] and created[:10] < cutoff_str:
            continue
        items = load_commitments(mid)
        if items is None:
            if meta.get("status") != "ready":
                continue
            paras = _load_paras_for_meeting(mid)
            items = extract_commitments_rules(meta, paras) if paras else []
        mtitle = str(meta.get("title") or mid)
        for raw in items:
            if raw.get("dismissed"):
                continue
            done = bool(raw.get("done"))
            age_days = 0.0
            if created:
                try:
                    age_days = (now_dt - datetime.fromisoformat(created[:19])).total_seconds() / 86400.0
                except ValueError:
                    age_days = 0.0
            entry = {
                **raw,
                "mid": mid,
                "meeting_title": mtitle,
                "created": created,
                "done": done,
                "overdue": (not done) and age_days >= 3.0,
            }
            all_items.append(entry)

    all_items.sort(key=lambda x: (bool(x.get("done")), not bool(x.get("overdue")), str(x.get("created") or "")), reverse=False)
    # 未完成按创建时间倒序、已完成沉底
    open_items = sorted(
        [x for x in all_items if not x["done"]],
        key=lambda x: (bool(x.get("overdue")), str(x.get("created") or "")),
        reverse=True,
    )
    done_items = sorted(
        [x for x in all_items if x["done"]],
        key=lambda x: str(x.get("created") or ""),
        reverse=True,
    )
    counts = {
        "open": len(open_items),
        "done": len(done_items),
        "total": len(all_items),
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
    return {"counts": counts, "items": out}


def _materialize_commitments(mid: str) -> list[dict]:
    items = load_commitments(mid)
    if items is not None:
        return items
    meta = store.get(mid)
    if not meta:
        return []
    paras = _load_paras_for_meeting(mid)
    return extract_commitments_rules(meta, paras) if paras else []


def toggle_commitment(mid: str, cid: str, done: bool) -> dict | None:
    with store.locked():
        if not store.exists(mid):
            return None
        items = _materialize_commitments(mid)
        target = next((x for x in items if str(x.get("id")) == cid), None)
        if target is None:
            return None
        target["done"] = bool(done)
        target["done_at"] = _now_iso() if done else ""
        save_commitments(mid, items)
        return dict(target)


def dismiss_commitment(mid: str, cid: str) -> bool:
    with store.locked():
        if not store.exists(mid):
            return False
        items = _materialize_commitments(mid)
        target = next((x for x in items if str(x.get("id")) == cid), None)
        if target is None:
            return False
        target["dismissed"] = True
        save_commitments(mid, items)
        return True


def restore_commitment(mid: str, cid: str) -> bool:
    with store.locked():
        if not store.exists(mid):
            return False
        items = _materialize_commitments(mid)
        target = next((x for x in items if str(x.get("id")) == cid), None)
        if target is None:
            return False
        target["dismissed"] = False
        save_commitments(mid, items)
        return True


def retrieve_global_context(query: str, limit: int = 8) -> list[dict]:
    """跨全部历史会议检索最相关的发言段落（供全局闪问 RAG 与纯检索降级复用）。"""
    q = (query or "").strip()
    if not q:
        return []
    ql = q.lower()
    q_tokens = {t.lower() for t in relations._extract_tokens(q)}
    candidates: list[dict] = []

    for meta in store.list_all():
        mid = str(meta.get("id") or "")
        if not mid or rsi_events.is_excluded(meta):
            continue
        title = str(meta.get("title") or mid)
        brief = str(meta.get("brief") or "")
        created = str(meta.get("created") or "")
        title_hit = 1.5 if (ql in title.lower() or (brief and ql in brief.lower())) else 0.0
        if not title_hit and q_tokens:
            tb_tokens = {t.lower() for t in relations._extract_tokens(f"{title} {brief}")}
            if tb_tokens & q_tokens:
                title_hit = 1.0 * len(tb_tokens & q_tokens)

        paras = _load_paras_for_meeting(mid)
        if paras:
            per_meeting: list[dict] = []
            for p in paras:
                txt = str(p.get("text") or "").strip()
                if len(txt) < 4:
                    continue
                tl = txt.lower()
                score = title_hit
                if ql in tl:
                    score += 6.0
                if q_tokens:
                    p_toks = {t.lower() for t in relations._extract_tokens(txt)}
                    overlap = len(q_tokens & p_toks)
                    if overlap:
                        score += overlap * 2.5 / math.sqrt(max(1, len(p_toks)))
                    else:
                        # 子串兜底（如英文词或短人名）
                        sub_hits = sum(1 for t in q_tokens if len(t) >= 2 and t in tl)
                        score += sub_hits * 1.4
                if score <= title_hit and score < 1.5:
                    continue
                start_ms = int(p.get("start") or 0)
                per_meeting.append({
                    "mid": mid,
                    "title": title,
                    "created": created,
                    "ts": _fmt_ts(start_ms),
                    "start_ms": start_ms,
                    "speaker": _speaker_label(meta, p),
                    "quote": txt[:200],
                    "score": round(score, 3),
                })
            per_meeting.sort(key=lambda x: -x["score"])
            candidates.extend(per_meeting[:2])
        else:
            mn = store.load(mid, "minutes.json")
            md = str(mn.get("markdown") or "") if isinstance(mn, dict) else ""
            if md and (ql in md.lower() or any(t in md.lower() for t in q_tokens)):
                candidates.append({
                    "mid": mid,
                    "title": title,
                    "created": created,
                    "ts": "00:00",
                    "start_ms": 0,
                    "speaker": "纪要",
                    "quote": md.strip().splitlines()[0][:200],
                    "score": round(2.5 + title_hit, 3),
                })

    candidates.sort(key=lambda x: (-x["score"], str(x.get("created") or "")), reverse=False)
    candidates.sort(key=lambda x: -x["score"])
    return candidates[: max(1, min(16, limit))]


async def global_ask(query: str, prov: dict | None) -> dict:
    q = (query or "").strip()
    if not q:
        return {"query": "", "answer": "请输入想查询的问题或关键词。", "citations": [], "mode": "search"}
    citations = retrieve_global_context(q, limit=8)
    if not citations:
        return {
            "query": q,
            "answer": f"在已有会议和全天记录里没有找到和「{q}」直接相关的内容。",
            "citations": [],
            "mode": "search",
        }

    if _provider_usable(prov):
        ctx_lines = [
            f"[{idx}] {c['title']} ({c['created'][:10]} {c['ts']}) "
            f"{c['speaker'] + '：' if c['speaker'] else ''}{c['quote']}"
            for idx, c in enumerate(citations, 1)
        ]
        msgs = [
            {
                "role": "system",
                "content": (
                    "你是个人会议记忆助手。严格根据以下编号引用回答用户问题：\n"
                    "1. 直接给结论，2-5句话写清「结论 / 谁说的 / 时间与约束」，不要编造。\n"
                    "2. 在对应事实后标注来源编号，例如 [1]、[2]。\n"
                    "3. 证据不足时坦诚指出。"
                ),
            },
            {"role": "user", "content": f"问题：{q}\n\n检索到的相关记录：\n" + "\n".join(ctx_lines)},
        ]
        try:
            ans = (await llm.chat(prov, msgs, temperature=0.2, max_tokens=900)).strip()
            if ans:
                return {"query": q, "answer": ans, "citations": citations, "mode": "llm"}
        except Exception:  # noqa: BLE001
            pass

    lines = [f"找到 {len(citations)} 条最相关记录："]
    for idx, c in enumerate(citations[:4], 1):
        who = f"{c['speaker']}：" if c["speaker"] else ""
        lines.append(f"[{idx}]《{c['title']}》[{c['ts']}] {who}{c['quote']}")
    return {"query": q, "answer": "\n".join(lines), "citations": citations, "mode": "search"}


def week_bounds(end_date: str | None = None) -> tuple[str, str, str]:
    if end_date:
        dt = datetime.strptime(end_date, "%Y-%m-%d")
    else:
        dt = datetime.now()
    monday = dt - timedelta(days=dt.weekday())
    sunday = monday + timedelta(days=6)
    iso_year, iso_week, _ = monday.isocalendar()
    return f"{iso_year}-W{iso_week:02d}", monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d")


def collect_week_data(end_date: str | None = None) -> dict:
    week_id, start_ymd, end_ymd = week_bounds(end_date)
    metas = [
        m
        for m in store.list_all()
        if start_ymd <= str(m.get("created") or "")[:10] <= end_ymd
    ]
    metas.sort(key=lambda m: str(m.get("created") or ""))

    daily_dir = _daily_dir()
    daily_summaries: list[dict] = []
    cur = datetime.strptime(start_ymd, "%Y-%m-%d")
    for i in range(7):
        dstr = (cur + timedelta(days=i)).strftime("%Y-%m-%d")
        rec = store.read_json(daily_dir / f"{dstr}.json")
        if isinstance(rec, dict) and rec.get("markdown"):
            daily_summaries.append({
                "date": dstr,
                "markdown": str(rec["markdown"]),
                "created": str(rec.get("created") or ""),
            })

    todos_resp = relations.list_todos(status="all")
    week_todos = [
        t for t in todos_resp.get("items") or []
        if start_ymd <= str(t.get("meeting_created") or "")[:10] <= end_ymd
    ]
    comm_resp = list_commitments(status="all", days=0)
    week_commits = [
        c for c in comm_resp.get("items") or []
        if start_ymd <= str(c.get("created") or "")[:10] <= end_ymd
    ]

    total_s = sum(
        float(m.get("speech_s") if m.get("source") == "ambient" and m.get("speech_s") else (m.get("duration") or 0))
        for m in metas
    )
    active_days = len({str(m.get("created") or "")[:10] for m in metas if m.get("created")})
    saved = store.read_json(daily_dir / f"weekly-{week_id}.json")
    return {
        "week_id": week_id,
        "start_date": start_ymd,
        "end_date": end_ymd,
        "meeting_count": len(metas),
        "active_days": active_days,
        "total_s": round(total_s, 1),
        "meetings": [
            {
                "id": m["id"],
                "title": m.get("title") or m["id"],
                "brief": m.get("brief") or "",
                "tags": m.get("tags") or [],
                "created": m.get("created") or "",
                "duration": m.get("duration") or 0,
                "source": m.get("source") or "",
            }
            for m in metas
        ],
        "daily_summaries": daily_summaries,
        "todos": week_todos,
        "commitments": week_commits,
        "report": saved if isinstance(saved, dict) and saved.get("markdown") else None,
    }


def build_local_weekly_markdown(week_data: dict) -> str:
    """不依赖大模型，直接把本周日报、一句话结论与待办/承诺拼装成结构化周报草稿。"""
    wid = week_data["week_id"]
    lines = [
        f"# 工作周报（{week_data['start_date']} ~ {week_data['end_date']} · {wid}）",
        "",
        "## 本周概览",
        f"- 活跃 **{week_data['active_days']} 天**，共沉淀 **{week_data['meeting_count']} 段** 会议与工作对话（累计约 **{round(week_data['total_s'] / 60)} 分钟**）。",
    ]
    if week_data.get("daily_summaries"):
        lines.extend(["", "## 每日进展摘要"])
        for ds in week_data["daily_summaries"]:
            snippet_lines = [ln.strip() for ln in ds["markdown"].splitlines() if ln.strip() and not ln.startswith("# ")]
            preview = "\n".join(snippet_lines[:8])
            lines.extend([f"### {ds['date']}", preview, ""])
    elif week_data.get("meetings"):
        lines.extend(["", "## 主要沟通记录"])
        for m in week_data["meetings"][:25]:
            brief = f" — {m['brief']}" if m.get("brief") else ""
            lines.append(f"- `{m['created'][:16].replace('T', ' ')}` **{m['title']}**{brief}")

    done_todos = [t for t in week_data.get("todos") or [] if t.get("done")]
    open_todos = [t for t in week_data.get("todos") or [] if not t.get("done")]
    open_commits = [c for c in week_data.get("commitments") or [] if not c.get("done")]

    lines.extend(["", "## 已完成事项"])
    if done_todos:
        lines.extend([f"- [x] {t['text']}（{t['meeting_title']}）" for t in done_todos[:20]])
    else:
        lines.append("- 本周暂无勾选完成的纪要待办。")

    lines.extend(["", "## 待跟进事项与承诺"])
    if open_todos or open_commits:
        for t in open_todos[:15]:
            lines.append(f"- [ ] {t['text']}（{t['meeting_title']}）")
        for c in open_commits[:15]:
            tag = "我方承诺" if c.get("direction") == "mine" else "待对方反馈"
            due = f" · {c['due_hint']}" if c.get("due_hint") else ""
            lines.append(f"- [ ] [{tag}] {c['text']}{due}（{c['meeting_title']}）")
    else:
        lines.append("- 当前无遗留待跟进事项。")

    return "\n".join(lines).strip() + "\n"


def save_weekly_report(week_id: str, rec: dict) -> dict:
    ddir = _daily_dir()
    ddir.mkdir(parents=True, exist_ok=True)
    store.write_json(ddir / f"weekly-{week_id}.json", rec)
    return rec


async def weekly_gen_stream(end_date: str | None, prov: dict) -> AsyncIterator[str]:
    t0 = time.time()
    data = collect_week_data(end_date)
    if not data["meetings"] and not data["daily_summaries"]:
        yield _ndjson({"type": "error", "msg": "这一周还没有可汇总的会议或对话记录"})
        return

    blocks: list[str] = []
    for ds in data["daily_summaries"]:
        blocks.append(f"## 日报 {ds['date']}\n{ds['markdown'][:2400]}")
    covered_dates = {ds["date"] for ds in data["daily_summaries"]}
    for m in data["meetings"]:
        dstr = m["created"][:10]
        if dstr in covered_dates and not m.get("brief"):
            continue
        extra = ""
        if m.get("brief"):
            extra = m["brief"]
        else:
            ps = _load_paras_for_meeting(m["id"])
            extra = " ".join(str(p.get("text") or "") for p in ps[:12])[:300]
        blocks.append(f"- [{m['created'][:16]}] {m['title']}：{extra}")

    todo_lines = [
        f"- [{'x' if t['done'] else ' '}] {t['text']} ({t['meeting_title']})"
        for t in (data["todos"] or [])[:20]
    ]
    for c in (data["commitments"] or [])[:15]:
        tag = "我承诺" if c.get("direction") == "mine" else "等对方"
        todo_lines.append(f"- [{'x' if c.get('done') else ' '}] [{tag}] {c['text']} ({c['meeting_title']})")

    budget = max(2500, int(prov.get("max_input_chars") or 60000) - 3000)
    ctx_text = "\n\n".join(blocks)[:budget]
    todo_text = "\n".join(todo_lines) or "（无）"

    msgs = [
        {
            "role": "system",
            "content": (
                "你是高效的工程/产品工作周报助手。根据本周的每日总结、对话摘要和待办承诺，撰写结构清晰、客观务实的中文工作周报。"
                "包含：`# 本周工作周报`、`## 核心进展与产出`、`## 重要决议与项目动向`、`## 下周待办与风险跟进`。只写事实，不编造数据。"
            ),
        },
        {
            "role": "user",
            "content": f"周期：{data['start_date']} ~ {data['end_date']}（{data['meeting_count']} 场记录）\n\n本周材料：\n{ctx_text}\n\n待办与承诺：\n{todo_text}",
        },
    ]

    out = ""
    try:
        yield _ndjson({"type": "status", "msg": f"{prov['name']} 正在生成本周周报…"})
        async for kind, delta in llm.chat_events(prov, msgs, max_tokens=4000):
            if kind == "think":
                yield _ndjson({"type": "status", "msg": f"{prov['name']} 正在思考，已 {delta} 秒"})
                continue
            out += str(delta)
            yield _ndjson({"type": "delta", "text": str(delta)})
        rec = save_weekly_report(
            data["week_id"],
            {
                "week_id": data["week_id"],
                "start_date": data["start_date"],
                "end_date": data["end_date"],
                "markdown": out.strip(),
                "provider": prov["name"],
                "model": prov["model"],
                "created": _now_iso(),
                "cost": round(time.time() - t0, 1),
            },
        )
        yield _ndjson({"type": "done", "report": rec})
    except llm.LLMError as e:
        yield _ndjson({"type": "error", "msg": str(e)})
    except Exception as e:  # noqa: BLE001
        yield _ndjson({"type": "error", "msg": str(e) or "周报生成出错，请稍后重试"})
