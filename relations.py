from __future__ import annotations

import hashlib
import math
import re
import threading
import time
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import store

_lock = threading.RLock()
_profile_cache: dict[str, tuple[tuple, dict]] = {}

_GENERIC_SPK_RE = re.compile(r"^说话人\s*\d+$")
_GENERIC_NAMES = frozenset({"我", "对方", "主持人", "系统", "未知", "发言人"})
_AUTO_TITLE_RE = re.compile(r"^(?:自动记录\s+\d{1,2}:\d{2}|会议\s+\d{2}-\d{2}\s+\d{1,2}:\d{2}|新会议)$")

_EN_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+.-]{1,23}")
_ZH_RUN_RE = re.compile(r"[\u4e00-\u9fff]{2,12}")
_MAX_ZH_SCAN_CHARS = 12000
_ZH_INTACT_MAX_LEN = 4
_ZH_NGRAM_SIZES = (2, 3)

_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
_TODO_LINE_RE = re.compile(r"^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s+)(.*)$")
_TS_INLINE_RE = re.compile(r"\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[,，、]\s*\d{1,2}:\d{2}(?::\d{2})?)*\]")

_STOPWORDS = frozenset({
    "我们", "你们", "他们", "她们", "自己", "这个", "那个", "这些", "那些", "这样", "那样",
    "什么", "怎么", "为什么", "可以", "应该", "需要", "已经", "现在", "目前", "今天", "明天",
    "昨天", "时候", "时间", "问题", "情况", "方面", "部分", "地方", "东西", "事情", "一下",
    "一个", "一些", "一点", "一起", "一直", "一般", "如果", "因为", "所以", "但是", "然后",
    "还是", "或者", "而且", "不过", "其实", "就是", "不是", "没有", "可能", "觉得", "知道",
    "感觉", "比较", "非常", "特别", "主要", "基本", "大概", "肯定", "直接",
    "开始", "结束", "完成", "进行", "处理", "确认", "沟通", "讨论", "会议", "记录", "纪要",
    "待办", "结论", "议题", "内容", "相关", "具体", "整体", "后续", "之前", "之后", "里面",
    "上面", "下面", "前面", "后面", "大家", "各位", "这边", "那边", "这里", "那里", "的话",
    "对吧", "是吧", "好吧", "好的", "行吧", "没问题", "谢谢", "就是说",
    "比如说", "实际上", "基本上", "一般来说", "然后再", "就可以", "是不是", "有没有",
    "the", "and", "for", "that", "this", "with", "from", "have", "will", "are", "was",
    "not", "but", "can", "you", "our", "all", "one", "out", "use", "get", "has", "had",
    "http", "https", "www", "com", "true", "false", "null", "none", "todo", "done",
})


def is_named_speaker(name: str) -> bool:
    v = str(name or "").strip()
    if not v or len(v) > 32:
        return False
    if _GENERIC_SPK_RE.match(v) or v in _GENERIC_NAMES:
        return False
    return True


def _extract_tokens(text: str) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    for m in _EN_TOKEN_RE.finditer(text):
        w = m.group(0).strip(".-_")
        if len(w) >= 2 and w.lower() not in _STOPWORDS:
            out.append(w)
    zh_runs = _ZH_RUN_RE.findall(text[:_MAX_ZH_SCAN_CHARS])
    for run in zh_runs:
        n = len(run)
        if 2 <= n <= _ZH_INTACT_MAX_LEN:
            if run not in _STOPWORDS:
                out.append(run)
        else:
            for k in _ZH_NGRAM_SIZES:
                for i in range(0, n - k + 1):
                    g = run[i : i + k]
                    if g not in _STOPWORDS:
                        out.append(g)
    return out


def _file_sig(p: Path) -> tuple[int, int]:
    try:
        st = p.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


def _meeting_profile(meta: dict) -> dict:
    mid = str(meta.get("id") or "")
    d = store.MEETINGS / mid
    notes_sig = _file_sig(d / "notes.md")
    if notes_sig == (0, 0):
        notes_sig = _file_sig(d / "notes.txt")
    sig = (
        str(store.DATA),
        _file_sig(d / "meta.json"),
        _file_sig(d / "minutes.json"),
        _file_sig(d / "transcript.json"),
        notes_sig,
    )
    with _lock:
        hit = _profile_cache.get(mid)
        if hit and hit[0] == sig:
            return hit[1]

    speakers_raw = meta.get("speakers") or {}
    named_speakers: list[str] = []
    seen_spk: set[str] = set()
    for v in speakers_raw.values():
        s = str(v or "").strip()
        if is_named_speaker(s) and s not in seen_spk:
            seen_spk.add(s)
            named_speakers.append(s)

    weights: Counter[str] = Counter()
    display_form: dict[str, str] = {}

    def add_text(txt: str, w: float, cap: int = 8000):
        if not txt:
            return
        for tok in _extract_tokens(txt[:cap]):
            key = tok.lower()
            weights[key] += w
            if key not in display_form or (tok != tok.lower() and display_form[key] == key):
                display_form[key] = tok

    title = str(meta.get("title") or "").strip()
    if title and not _AUTO_TITLE_RE.match(title):
        add_text(title, 3.5, 400)

    hw = str(meta.get("hotword") or "").strip()
    if hw:
        for w in re.split(r"[\s,，、;；]+", hw):
            w = w.strip()
            if len(w) >= 2 and w.lower() not in _STOPWORDS:
                weights[w.lower()] += 3.0
                display_form[w.lower()] = w

    notes_path = d / "notes.md"
    if not notes_path.exists():
        notes_path = d / "notes.txt"
    if notes_path.exists():
        try:
            add_text(notes_path.read_text(encoding="utf-8", errors="ignore"), 2.5, 4000)
        except OSError:
            pass

    mn = store.load(mid, "minutes.json")
    has_minutes = False
    if isinstance(mn, dict) and mn.get("markdown"):
        has_minutes = True
        md_txt = str(mn["markdown"])
        for hm in re.findall(r"^#{1,4}\s+(.+)$", md_txt, flags=re.M):
            add_text(hm, 2.5, 300)
        for bm in re.findall(r"\*\*(.+?)\*\*", md_txt):
            add_text(bm, 2.0, 200)
        add_text(md_txt, 1.5, 6000)

    tr = store.load(mid, "transcript.json")
    if isinstance(tr, dict) and tr.get("paragraphs"):
        sample_txt = " ".join(str(p.get("text") or "") for p in tr["paragraphs"][:180])
        add_text(sample_txt, 1.0, 10000)

    top_terms = dict(weights.most_common(60))
    prof = {
        "id": mid,
        "title": title or mid,
        "created": str(meta.get("created") or ""),
        "duration": meta.get("speech_s") if meta.get("source") == "ambient" else meta.get("duration", 0),
        "source": meta.get("source") or "mic",
        "status": meta.get("status") or "",
        "speakers": named_speakers,
        "terms": top_terms,
        "display": {k: display_form.get(k, k) for k in top_terms},
        "has_minutes": has_minutes,
    }
    with _lock:
        if len(_profile_cache) > 1000:
            _profile_cache.clear()
        _profile_cache[mid] = (sig, prof)
    return prof


def invalidate_cache(mid: str | None = None) -> None:
    with _lock:
        if mid is None:
            _profile_cache.clear()
        else:
            _profile_cache.pop(mid, None)


def _iso_to_ts(iso: str) -> float:
    if not iso:
        return 0.0
    try:
        t = time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
        return time.mktime(t)
    except Exception:
        return 0.0


def related_meetings(mid: str, limit: int = 5) -> list[dict]:
    limit = max(1, min(20, int(limit or 5)))
    metas = store.list_all()
    target_meta = next((m for m in metas if m.get("id") == mid), None)
    if not target_meta:
        return []

    profiles = [_meeting_profile(m) for m in metas]
    target = next((p for p in profiles if p["id"] == mid), None)
    if not target:
        return []

    n_docs = max(1, len(profiles))
    df: Counter[str] = Counter()
    for p in profiles:
        for k in p["terms"]:
            df[k] += 1

    def idf(term: str) -> float:
        return math.log((n_docs + 1.0) / (df[term] + 1.0)) + 1.0

    t_spk = set(target["speakers"])
    t_vec = {k: math.log1p(v) * idf(k) for k, v in target["terms"].items()}
    t_norm = math.sqrt(sum(v * v for v in t_vec.values())) or 1.0
    t_ts = _iso_to_ts(target["created"])

    scored: list[dict] = []
    for p in profiles:
        if p["id"] == mid:
            continue
        shared_spk = [s for s in target["speakers"] if s in set(p["speakers"])]
        p_vec = {k: math.log1p(v) * idf(k) for k, v in p["terms"].items()}
        common_keys = set(t_vec) & set(p_vec)
        dot = sum(t_vec[k] * p_vec[k] for k in common_keys)
        p_norm = math.sqrt(sum(v * v for v in p_vec.values())) or 1.0
        cos = dot / (t_norm * p_norm) if common_keys else 0.0

        spk_lowers = {s.lower() for s in shared_spk}
        shared_terms_ranked = sorted(
            (k for k in common_keys if k not in spk_lowers and len(k) >= 2),
            key=lambda k: t_vec[k] * p_vec[k],
            reverse=True,
        )
        shared_terms = [target["display"].get(k) or p["display"].get(k) or k for k in shared_terms_ranked[:4]]

        spk_score = min(0.55, 0.28 * len(shared_spk)) if shared_spk else 0.0
        if not shared_spk and (cos < 0.08 or len(shared_terms) < 2):
            continue
        if shared_spk and cos < 0.01 and len(t_spk) == 0:
            continue

        p_ts = _iso_to_ts(p["created"])
        days_diff = abs(t_ts - p_ts) / 86400.0 if (t_ts and p_ts) else 999.0
        recency = 0.06 * math.exp(-days_diff / 14.0) if days_diff < 90 else 0.0

        score = round(min(0.99, cos * 0.72 + spk_score + recency), 3)
        scored.append({
            "id": p["id"],
            "title": p["title"],
            "created": p["created"],
            "duration": p["duration"],
            "source": p["source"],
            "has_minutes": p["has_minutes"],
            "score": score,
            "shared_speakers": shared_spk[:4],
            "shared_terms": shared_terms,
        })

    scored.sort(key=lambda x: (x["score"], x["created"]), reverse=True)
    return scored[:limit]


def _iter_todo_lines(lines: list[str]) -> Iterator[tuple[int, int, re.Match[str], str]]:
    in_fence = False
    fence_char = ""
    fence_len = 0
    todo_idx = 0
    for line_idx, raw in enumerate(lines):
        cr = "\r" if raw.endswith("\r") else ""
        ln = raw[:-1] if cr else raw
        fm = _FENCE_RE.match(ln)
        if fm:
            marker = fm.group(1)
            if not in_fence:
                in_fence = True
                fence_char = marker[0]
                fence_len = len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_len and ln.strip() == marker:
                in_fence = False
            continue
        if in_fence:
            continue
        m = _TODO_LINE_RE.match(ln)
        if not m:
            continue
        yield line_idx, todo_idx, m, cr
        todo_idx += 1


def parse_markdown_todos(raw_md: str) -> list[dict]:
    lines = str(raw_md or "").split("\n")
    items: list[dict] = []
    for _, idx, m, _ in _iter_todo_lines(lines):
        done = m.group(2).strip().lower() == "x"
        text = m.group(4).strip()
        ts_m = _TS_INLINE_RE.search(text)
        items.append({
            "idx": idx,
            "done": done,
            "text": text,
            "ts": ts_m.group(1) if ts_m else "",
        })
    return items


def toggle_markdown_todo(raw_md: str, todo_idx: int, done: bool) -> tuple[str, bool]:
    src = str(raw_md or "")
    lines = src.split("\n")
    for line_idx, idx, m, cr in _iter_todo_lines(lines):
        if idx == todo_idx:
            mark = "x" if done else " "
            lines[line_idx] = f"{m.group(1)}[{mark}]{m.group(3)}{m.group(4)}{cr}"
            return "\n".join(lines), True
    return src, False


def list_todos(status: str = "open", person: str = "", limit: int = 200) -> dict:
    status = status if status in ("open", "done", "all") else "open"
    person_q = str(person or "").strip()
    limit = max(1, min(500, int(limit or 200)))

    metas = store.list_all()
    open_cnt = 0
    done_cnt = 0
    out: list[dict] = []

    for meta in metas:
        mid = meta.get("id")
        if not mid:
            continue
        mn = store.load(mid, "minutes.json")
        if not isinstance(mn, dict) or not mn.get("markdown"):
            continue
        todos = parse_markdown_todos(mn["markdown"])
        if not todos:
            continue
        spks = [str(v).strip() for v in (meta.get("speakers") or {}).values() if is_named_speaker(v)]
        for t in todos:
            if person_q:
                if person_q not in spks and person_q not in t["text"]:
                    continue
            if t["done"]:
                done_cnt += 1
            else:
                open_cnt += 1
            if status == "open" and t["done"]:
                continue
            if status == "done" and not t["done"]:
                continue
            out.append({
                "mid": mid,
                "meeting_title": meta.get("title") or mid,
                "meeting_created": meta.get("created") or "",
                "idx": t["idx"],
                "done": t["done"],
                "text": t["text"],
                "ts": t["ts"],
                "speakers": spks[:6],
            })

    return {
        "counts": {"open": open_cnt, "done": done_cnt, "total": open_cnt + done_cnt},
        "items": out[:limit],
    }


def toggle_todo(mid: str, idx: int, done: bool) -> dict:
    if idx < 0:
        raise ValueError("无效的待办序号")
    with store.locked():
        mn = store.load(mid, "minutes.json")
        if not isinstance(mn, dict) or not mn.get("markdown"):
            raise FileNotFoundError("这场会议还没有生成纪要")
        new_md, ok = toggle_markdown_todo(mn["markdown"], idx, done)
        if not ok:
            raise IndexError("找不到对应的待办项")
        mn["markdown"] = new_md
        mn["edited"] = True
        store.save(mid, "minutes.json", mn)
    return {"ok": True, "mid": mid, "idx": idx, "done": bool(done)}


def list_people() -> list[dict]:
    metas = store.list_all()
    people: dict[str, dict] = {}
    for meta in metas:
        mid = meta.get("id")
        if not mid:
            continue
        spks = {str(v).strip() for v in (meta.get("speakers") or {}).values() if is_named_speaker(v)}
        if not spks:
            continue
        dur = float(meta.get("speech_s") if meta.get("source") == "ambient" else (meta.get("duration") or 0))
        created = str(meta.get("created") or "")
        mn = store.load(mid, "minutes.json")
        todos = parse_markdown_todos(mn["markdown"]) if isinstance(mn, dict) and mn.get("markdown") else []
        open_todos = sum(1 for t in todos if not t["done"])
        for name in spks:
            rec = people.setdefault(name, {
                "name": name,
                "meetings": 0,
                "total_s": 0.0,
                "open_todos": 0,
                "last_seen": "",
            })
            rec["meetings"] += 1
            rec["total_s"] += dur
            rec["open_todos"] += open_todos
            if created > rec["last_seen"]:
                rec["last_seen"] = created

    res = sorted(people.values(), key=lambda x: (x["meetings"], x["last_seen"]), reverse=True)
    for r in res:
        r["total_s"] = round(r["total_s"], 1)
    return res


def person_timeline(name: str) -> dict:
    target = str(name or "").strip()
    if not target:
        return {
            "name": "",
            "total_meetings": 0,
            "total_s": 0.0,
            "meetings": [],
            "co_speakers": [],
            "top_terms": [],
            "todos": [],
        }

    metas = store.list_all()
    meetings_out: list[dict] = []
    co_counts: Counter[str] = Counter()
    term_counts: Counter[str] = Counter()
    term_display: dict[str, str] = {}
    todos_out: list[dict] = []
    total_s = 0.0

    for meta in metas:
        mid = meta.get("id")
        if not mid:
            continue
        spk_map = meta.get("speakers") or {}
        named_ids = {k for k, v in spk_map.items() if str(v or "").strip() == target}
        if not named_ids:
            continue

        prof = _meeting_profile(meta)
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
            for t in parse_markdown_todos(mn["markdown"]):
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

    top_terms = [term_display[k] for k, _ in term_counts.most_common(12)]
    co_speakers = [{"name": n, "count": c} for n, c in co_counts.most_common(10)]
    return {
        "name": target,
        "total_meetings": len(meetings_out),
        "total_s": round(total_s, 1),
        "meetings": meetings_out,
        "co_speakers": co_speakers,
        "top_terms": top_terms,
        "todos": todos_out,
    }


def list_projects(days: int = 30, limit: int = 12) -> list[dict]:
    """按共享主题词/标签自动聚合成项目脉络流，便于从「事/项目」而不是按天回溯。"""
    metas = store.list_all()
    if days and days > 0:
        cutoff_ts = time.time() - days * 86400
        metas = [m for m in metas if not m.get("created") or _iso_to_ts(str(m.get("created") or "")) >= cutoff_ts]
    if not metas:
        return []

    profiles: list[dict] = []
    meta_by_id: dict[str, dict] = {}
    for meta in metas:
        mid = str(meta.get("id") or "")
        if not mid:
            continue
        prof = _meeting_profile(meta)
        # 一句话标签作为高权重项目信号注入
        tags = meta.get("tags") or []
        if isinstance(tags, list) and tags:
            terms = dict(prof["terms"])
            display = dict(prof["display"])
            for raw_tag in tags:
                t = str(raw_tag or "").strip()
                if 2 <= len(t) <= 12 and t.lower() not in _STOPWORDS:
                    tk = t.lower()
                    terms[tk] = terms.get(tk, 0.0) + 5.0
                    display[tk] = t
            prof = {**prof, "terms": terms, "display": display}
        profiles.append(prof)
        meta_by_id[mid] = meta

    n_docs = len(profiles)
    if n_docs < 2:
        return []

    df: Counter[str] = Counter()
    for p in profiles:
        for k in p["terms"]:
            if len(k) >= 2:
                df[k] += 1

    max_df = max(2, int(n_docs * 0.65)) if n_docs >= 6 else n_docs
    term_mids: dict[str, set[str]] = {}
    term_score: dict[str, float] = {}
    term_label: dict[str, str] = {}

    for p in profiles:
        mid = p["id"]
        for k, w in p["terms"].items():
            dcount = df[k]
            if dcount < 2 or dcount > max_df:
                continue
            idf = math.log((n_docs + 1.0) / (dcount + 1.0)) + 1.0
            term_mids.setdefault(k, set()).add(mid)
            term_score[k] = term_score.get(k, 0.0) + math.log1p(w) * idf
            lbl = str(p["display"].get(k, k))
            if k not in term_label or (lbl != lbl.lower() and term_label[k] == k):
                term_label[k] = lbl

    ranked_terms = sorted(term_mids.keys(), key=lambda k: (-len(term_mids[k]), -term_score.get(k, 0.0), k))
    prof_map = {p["id"]: p for p in profiles}

    clusters: list[dict] = []
    for tk in ranked_terms:
        mset = term_mids[tk]
        if len(mset) < 2:
            continue
        merged = False
        for cl in clusters:
            inter = len(mset & cl["mids"])
            union = len(mset | cl["mids"])
            if inter / max(1, min(len(mset), len(cl["mids"]))) >= 0.72 or (inter / max(1, union)) >= 0.60:
                if len(cl["keywords"]) < 5 and term_label[tk].lower() not in {x.lower() for x in cl["keywords"]}:
                    cl["keywords"].append(term_label[tk])
                cl["score"] += term_score.get(tk, 0.0)
                merged = True
                break
        if not merged:
            clusters.append({
                "anchor": tk,
                "name": term_label[tk],
                "keywords": [term_label[tk]],
                "mids": set(mset),
                "score": term_score.get(tk, 0.0),
            })

    projects: list[dict] = []
    for cl in clusters:
        mids = sorted(cl["mids"], key=lambda x: str(prof_map[x]["created"]), reverse=True)
        part_counts: Counter[str] = Counter()
        total_s = 0.0
        meeting_items: list[dict] = []
        for mid in mids:
            p = prof_map[mid]
            meta = meta_by_id[mid]
            total_s += float(p["duration"] or 0)
            for spk in p["speakers"]:
                part_counts[spk] += 1
            meeting_items.append({
                "id": mid,
                "title": p["title"],
                "brief": str(meta.get("brief") or ""),
                "tags": list(meta.get("tags") or []),
                "created": p["created"],
                "duration": p["duration"],
                "has_minutes": p["has_minutes"],
                "source": p["source"],
            })
        pid = f"prj-{hashlib.sha1((cl['anchor'] + '|' + str(len(mids))).encode('utf-8')).hexdigest()[:8]}"
        projects.append({
            "id": pid,
            "name": cl["name"],
            "keywords": cl["keywords"],
            "meeting_count": len(mids),
            "total_s": round(total_s, 1),
            "latest_at": meeting_items[0]["created"] if meeting_items else "",
            "participants": [n for n, _ in part_counts.most_common(6)],
            "meetings": meeting_items,
            "_sort_score": cl["score"],
        })

    projects.sort(key=lambda pr: (-pr["meeting_count"], -pr["_sort_score"], pr["latest_at"]))
    for pr in projects:
        pr.pop("_sort_score", None)
    return projects[: max(1, min(30, limit))]
