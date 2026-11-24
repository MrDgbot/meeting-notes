"""纪要生成后的确定性校验。

三步：模型只输出结构化 JSON → 这里用转写逐条核对截止期限、负责人和时间戳 → 再渲染成 Markdown。
对不上的期限改成「待定」并标明，时间戳能按原话对上的就改到原话的位置，对不上的标出来。
"""
import json
import re
import unicodedata

PENDING = "待定"
BLANK = {"", "待定", "未定", "无", "没有", "不详", "暂无", "未提及", "未说明", "tbd", "无期限", "不确定"}
TS_RE = re.compile(r"\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]")
OWNER_SKIP = {"我", "我们", "对方", "本人", "大家", "待定"}
_OWNER_SPLIT_RE = re.compile(r"[、,，/和及&]+")
_WEEKDAY_DIGITS = str.maketrans("123456", "一二三四五六")
_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_SMALL_RE = re.compile(r"(?:[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])(?=[月日号])")
_CN_PCT_RE = re.compile(r"百分之([零〇一二两三四五六七八九十百点\d.]+)")
_CN_NUM_RE = re.compile(
    r"[零〇一二两三四五六七八九十][零〇一二两三四五六七八九十百千万亿]*(?:点[零〇一二三四五六七八九]+[千万亿]?)?"
)
_ARABIC_SHORTHAND_RES = (
    (re.compile(r"(?<!\d)(\d+)万([1-9])千?(?![\d百十万亿])"), 10000, 1000),
    (re.compile(r"(?<!\d)(\d+)千([1-9])百?(?![\d十万亿])"), 1000, 100),
    (re.compile(r"(?<!\d)(\d+)百([1-9])十?(?![\d万亿])"), 100, 10),
)
# 高信号量化数字：百分比、货币、数量级与技术单位（排除通用概括计数词与日期/时间单位，避免误伤年份、人数、条数等）
_QTY_RE = re.compile(
    r"(?<![A-Za-z0-9:./-])"
    r"(\d+(?:\.\d+)?)\s*"
    r"(%|万|亿|千|元|块|美元|美金|刀|倍|折|MB|GB|TB|KB|ms|px|k|K|M|W)"
    r"(?![A-Za-z0-9])"
)
_SPK_LABEL_RE = re.compile(r"说话人\s*\d+")


def _fmt_num(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.6f}".rstrip("0").rstrip(".")


def _cn_to_num(token: str) -> str:
    """把常见中文数字（含口语缩略如 一百五、一千五、两万五、三千二、两点五万）转成阿拉伯数字串，便于与模型数字比对。"""
    if not token:
        return token
    if all(ch.isdigit() or ch == "." for ch in token):
        return token
    if token.startswith(("千", "万", "亿")):
        return token
    if "点" in token:
        a, b = token.split("点", 1)
        if not b:
            return token
        mult = 1
        if b[-1] in ("千", "万", "亿"):
            mult = {"千": 1000, "万": 10000, "亿": 100000000}[b[-1]]
            b = b[:-1]
        if not b:
            return token
        ai = _cn_to_num(a) if a else "0"
        bi = "".join(str(_CN_DIGITS[ch]) if ch in _CN_DIGITS else ch for ch in b)
        if not (ai.isdigit() and bi.isdigit()):
            return token
        if mult > 1:
            return _fmt_num(float(f"{ai}.{bi}") * mult)
        return f"{ai}.{bi}"

    total, sec, cur, cur_len = 0, 0, 0, 0
    has_unit = False
    last_unit = 0
    zero_after_unit = False
    small_units = {"十": 10, "百": 100, "千": 1000}
    big_units = {"万": 10000, "亿": 100000000}

    def _apply_tail(base: int, tail_cur: int, tail_len: int, lu: int, saw_zero: bool) -> int:
        if tail_cur > 0 and tail_len == 1 and lu > 10 and not saw_zero:
            return base + tail_cur * (lu // 10)
        return base + tail_cur

    for ch in token:
        if ch in _CN_DIGITS:
            d = _CN_DIGITS[ch]
            if d == 0:
                if has_unit and cur_len == 0:
                    zero_after_unit = True
                else:
                    cur = cur * 10
                    cur_len += 1
            else:
                cur = cur * 10 + d
                cur_len += 1
        elif ch in small_units:
            has_unit = True
            u = small_units[ch]
            sec += (cur if cur_len > 0 else 1) * u
            cur, cur_len = 0, 0
            last_unit = u
            zero_after_unit = False
        elif ch in big_units:
            has_unit = True
            u = big_units[ch]
            part = _apply_tail(sec, cur, cur_len, last_unit if last_unit < u else 0, zero_after_unit)
            if part == 0 and total == 0:
                part = 1
            if u == 100000000 and 0 < total < 100000000:
                total = (total + part) * u
            else:
                total += part * u
            sec, cur, cur_len = 0, 0, 0
            last_unit = u
            zero_after_unit = False
        else:
            return token

    if sec == 0 and last_unit >= 10000:
        val = _apply_tail(total, cur, cur_len, last_unit, zero_after_unit)
    else:
        val = total + _apply_tail(sec, cur, cur_len, last_unit, zero_after_unit)
    return str(val)


def _norm_cn_dates(s: str) -> str:
    return _CN_SMALL_RE.sub(lambda m: _cn_to_num(m.group(0)), s)


def _norm_nums(s: str) -> str:
    """把文本里的中文百分比/数量数字统一成阿拉伯数字（保留换行边界，避免跨段数字拼接）。"""
    s = unicodedata.normalize("NFKC", s or "")
    s = _CN_PCT_RE.sub(lambda m: _cn_to_num(m.group(1)) + "%", s)
    s = _CN_NUM_RE.sub(lambda m: _cn_to_num(m.group(0)), s)
    for pat, hi, lo in _ARABIC_SHORTHAND_RES:
        s = pat.sub(lambda m, hi=hi, lo=lo: str(int(m.group(1)) * hi + int(m.group(2)) * lo), s)
    return re.sub(r"[^\S\n]+", "", s).lower()


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    return re.sub(r"[\W_]+", "", s)


def due_key(due: str) -> str:
    s = unicodedata.normalize("NFKC", due or "").strip()
    s = (s.replace("下个星期", "下周").replace("下星期", "下周").replace("星期", "周")
          .replace("下个礼拜", "下周").replace("下礼拜", "下周").replace("礼拜", "周")
          .replace("周天", "周日"))
    s = re.sub(r"周([1-6])", lambda m: "周" + m.group(1).translate(_WEEKDAY_DIGITS), s)
    s = _norm_cn_dates(s)
    return re.sub(r"\s+", "", s)


def is_blank(s: str) -> bool:
    return due_key(s).lower() in BLANK


def parse_ts(s) -> int | None:
    if s is None:
        return None
    m = re.search(r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})", str(s))
    if not m:
        return None
    h, mi, sec = int(m.group(1) or 0), int(m.group(2)), int(m.group(3))
    if mi > 59 or sec > 59:
        return None
    return ((h * 60 + mi) * 60 + sec) * 1000


def fmt(ms: int | None) -> str:
    if ms is None:
        return ""
    s = max(0, int(round(ms / 1000)))
    if s >= 3600:
        return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}"
    return f"{s // 60:02d}:{s % 60:02d}"


def parse_json(text: str) -> dict:
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        i, j = raw.find("{"), raw.rfind("}")
        if i < 0 or j <= i:
            raise ValueError("模型没有返回可核对的纪要，请再生成一次") from None
        try:
            doc = json.loads(raw[i:j + 1])
        except json.JSONDecodeError as e:
            raise ValueError("模型没有返回可核对的纪要，请再生成一次") from e
    if not isinstance(doc, dict):
        raise ValueError("模型没有返回可核对的纪要，请再生成一次")
    return doc


def due_supported(due: str, support: str) -> bool:
    """期限必须在支撑文本里有原话。只出现「周四」不能支撑「下周四」或「周四全天」。"""
    if is_blank(due):
        return True
    d = due_key(due)
    sup = due_key(support)
    if not d:
        return True
    if d in sup:
        return True
    m = re.fullmatch(r"下周([一二三四五六日天])", d)
    if m and "下周" in sup and f"周{m.group(1)}" in sup:
        return True
    m = re.fullmatch(r"(\d{1,2})月(\d{1,2})[日号]?", d)
    if m and (f"{m.group(1)}月{m.group(2)}" in sup or f"{int(m.group(1))}月{int(m.group(2))}" in sup):
        return True
    return False


def _para_dist(p: dict, ts: int) -> int:
    start = p["start"]
    end = p.get("end", start)
    if start <= ts <= end:
        return 0
    return min(abs(start - ts), abs(end - ts))


def _quote_hit_idx(paras: list[dict], quote: str, ts: int | None = None,
                   norms: list[str] | None = None) -> tuple[dict | None, int | None]:
    q = norm(quote)
    if len(q) < 4 or not paras:
        return None, None
    ns = norms if norms is not None else [norm(p.get("text") or "") for p in paras]
    hits = [i for i, t in enumerate(ns) if q in t]
    if not hits:
        # 跨相邻段落的引用
        hits = [i for i in range(len(ns) - 1) if q in (ns[i] + ns[i + 1])]
    if not hits:
        return None, None
    idx = hits[0] if ts is None else min(hits, key=lambda i: _para_dist(paras[i], ts))
    return paras[idx], idx


def quote_hit(paras: list[dict], quote: str, ts: int | None = None) -> dict | None:
    hit, _ = _quote_hit_idx(paras, quote, ts)
    return hit


def window_text(paras: list[dict], ts: int | None, window_ms: int = 90000) -> str:
    if ts is None:
        return ""
    return "\n".join(
        p.get("text") or ""
        for p in paras
        if p["start"] - window_ms <= ts <= p.get("end", p["start"]) + window_ms
    )


def _nearby_text(paras: list[dict], idx: int, window_ms: int = 20000, radius: int = 2) -> str:
    hit = paras[idx]
    lo_t = hit["start"] - window_ms
    hi_t = hit.get("end", hit["start"]) + window_ms
    lo_i = max(0, idx - radius)
    hi_i = min(len(paras), idx + radius + 1)
    chosen = [
        paras[j].get("text") or ""
        for j in range(lo_i, hi_i)
        if j == idx or (paras[j].get("end", paras[j]["start"]) >= lo_t and paras[j]["start"] <= hi_t)
    ]
    return "\n".join(chosen)


def support_text(paras: list[dict], ts: int | None, quote: str, *,
                 hit_idx: int | None = None, norms: list[str] | None = None) -> str:
    if hit_idx is not None and 0 <= hit_idx < len(paras):
        return _nearby_text(paras, hit_idx)
    hit, idx = _quote_hit_idx(paras, quote, ts, norms)
    if hit is not None and idx is not None:
        return _nearby_text(paras, idx)
    return window_text(paras, ts)


def _fix_time_hit(ts: int | None, quote: str, paras: list[dict],
                  norms: list[str] | None = None) -> tuple[int | None, str, dict | None, int | None]:
    hit, idx = _quote_hit_idx(paras, quote, ts, norms)
    if hit is not None:
        end = hit.get("end", hit["start"])
        if ts is None or not (hit["start"] - 5000 <= ts <= end + 5000):
            return hit["start"], "corrected", hit, idx
        return ts, "ok", hit, idx
    if ts is None:
        return None, "empty", None, None
    for p in paras:
        if p["start"] - 2000 <= ts <= p.get("end", p["start"]) + 2000:
            return ts, "ok", None, None
    return ts, "missing", None, None


def fix_time(ts: int | None, quote: str, paras: list[dict]) -> tuple[int | None, str]:
    new_ts, status, _, _ = _fix_time_hit(ts, quote, paras)
    return new_ts, status


def time_label(ts: int | None, status: str) -> str:
    if status == "missing":
        return (fmt(ts) if ts is not None else "") + "（时间对不上）"
    if status == "corrected" and ts is not None:
        return fmt(ts) + "（已按原话校正）"
    return fmt(ts) if ts is not None else ""


def mark_times(text: str, paras: list[dict], checks: list[dict], where: str) -> str:
    def repl(m: re.Match) -> str:
        ts = parse_ts(m.group(0))
        _, status = fix_time(ts, "", paras)
        if status == "missing":
            checks.append({"kind": "time", "where": where, "from": m.group(0), "to": m.group(0) + "（时间对不上）",
                           "reason": "这个时间对不上转写"})
            return m.group(0) + "（时间对不上）"
        return m.group(0)
    return TS_RE.sub(repl, text or "")


def _known_speakers(speakers: dict | None) -> set[str]:
    out: set[str] = set()
    if not isinstance(speakers, dict):
        return out
    for v in speakers.values():
        name = str(v or "").strip()
        if not name or name in OWNER_SKIP or _SPK_LABEL_RE.fullmatch(name):
            continue
        nk = norm(name)
        if nk:
            out.add(nk)
    return out


def _owner(owner: str, paras: list[dict], *, blob: str | None = None,
           known_spks: set[str] | None = None) -> tuple[str, dict | None]:
    o = (owner or "").strip()
    if is_blank(o):
        return PENDING, None
    if o in OWNER_SKIP or _SPK_LABEL_RE.fullmatch(o):
        return "待定（原文未点名）", {"from": o, "reason": "负责人不是转写里点到的姓名"}
    if blob is None:
        blob = norm("\n".join(p.get("text") or "" for p in paras))
    spks = known_spks or set()
    parts = [x.strip() for x in _OWNER_SPLIT_RE.split(o) if x.strip()]
    if not parts:
        return PENDING, None

    def _valid_part(part: str) -> bool:
        if part in OWNER_SKIP or _SPK_LABEL_RE.fullmatch(part):
            return False
        np = norm(part)
        if not np:
            return False
        return np in spks or np in blob

    valid = [p for p in parts if _valid_part(p)]
    if len(valid) == len(parts):
        return o, None
    if valid:
        fixed = "、".join(valid)
        return fixed, {"from": o, "reason": "部分负责人未在转写或参会人中出现"}
    return "待定（原文未点名）", {"from": o, "reason": "转写里没有这个负责人"}


def _due(due: str, support: str) -> tuple[str, dict | None]:
    if is_blank(due):
        return PENDING, None
    if not due_supported(due, support):
        return "待定（原文未说明期限）", {"from": due_key(due) or due, "reason": "转写里没有这个期限"}
    return due_key(due), None


def _has_num(token: str, sup_norm: str) -> bool:
    return re.search(rf"(?<!\d)(?<!\d\.){re.escape(token)}(?!\.\d)(?!\d)", sup_norm) is not None


def _num_supported(num: str, unit: str, sup_norm: str) -> bool:
    """检查数字（如 21%、20万、300元）是否能在归一化后的支撑文本里找到对应数值。"""
    if not sup_norm:
        return False
    n = num.rstrip("0").rstrip(".") if "." in num else num
    u = unit.lower()
    num_pat = f"(?:{re.escape(num)}|{re.escape(n)})"
    if u == "%":
        return (
            re.search(rf"(?<!\d)(?<!\d\.){num_pat}%", sup_norm) is not None
            or re.search(rf"(?<!\d)(?<!\d\.){re.escape(n)}(?!\.\d)(?![\d万亿w])", sup_norm) is not None
        )
    # 精确「数+单位」（带左数字边界，避免 5万 误命中 15万）
    if re.search(rf"(?<!\d)(?<!\d\.){num_pat}{re.escape(u)}", sup_norm):
        return True
    try:
        fval = float(num)
    except ValueError:
        fval = None
    if u in ("万", "w") and fval is not None:
        if re.search(rf"(?<!\d)(?<!\d\.){num_pat}[万w]", sup_norm):
            return True
        if _has_num(_fmt_num(fval * 10000), sup_norm):
            return True
        if fval >= 10000:
            yi = _fmt_num(fval / 10000)
            if re.search(rf"(?<!\d)(?<!\d\.){re.escape(yi)}亿", sup_norm):
                return True
        # 区间省略单位：如「十五到二十万」→「15万到20万」
        if re.search(rf"(?<!\d)(?<!\d\.){re.escape(n)}(?:到|至|-|~|—|、|或)\d+(?:\.\d+)?(?:[万w]|0000(?!\d))", sup_norm):
            return True
        return False
    if u in ("千", "k") and fval is not None:
        if re.search(rf"(?<!\d)(?<!\d\.){num_pat}[千k]", sup_norm):
            return True
        if _has_num(_fmt_num(fval * 1000), sup_norm):
            return True
        wan = _fmt_num(fval / 10)
        if re.search(rf"(?<!\d)(?<!\d\.){re.escape(wan)}[万w]", sup_norm):
            return True
        if re.search(rf"(?<!\d)(?<!\d\.){re.escape(n)}(?:到|至|-|~|—|、|或)\d+(?:\.\d+)?(?:[千k]|000(?!\d))", sup_norm):
            return True
        return False
    if u == "亿" and fval is not None:
        if _has_num(_fmt_num(fval * 100000000), sup_norm):
            return True
        wan = _fmt_num(fval * 10000)
        if re.search(rf"(?<!\d)(?<!\d\.){re.escape(wan)}[万w]", sup_norm):
            return True
        if re.search(rf"(?<!\d)(?<!\d\.){re.escape(n)}(?:到|至|-|~|—|、|或)\d+(?:\.\d+)?(?:亿|00000000(?!\d))", sup_norm):
            return True
        return False
    # 其他单位（元/块/美元/倍/折/MB/GB/ms/px/M 等）：允许量级换算（如 25000元 ↔ 2.5万、1500元 ↔ 1.5k）或独立数值匹配
    if fval is not None:
        if u == "m" and _has_num(_fmt_num(fval * 1000000), sup_norm):
            return True
        if fval >= 10000 or (fval >= 1000 and abs(fval % 1000) < 1e-9):
            wan = _fmt_num(fval / 10000)
            if re.search(rf"(?<!\d)(?<!\d\.){re.escape(wan)}[万w]", sup_norm):
                return True
        if fval >= 1000:
            qian = _fmt_num(fval / 1000)
            if re.search(rf"(?<!\d)(?<!\d\.){re.escape(qian)}[千k]", sup_norm):
                return True
        if fval >= 10000000:
            yi = _fmt_num(fval / 100000000)
            if re.search(rf"(?<!\d)(?<!\d\.){re.escape(yi)}亿", sup_norm):
                return True
    return re.search(rf"(?<!\d)(?<!\d\.){re.escape(n)}(?!\.\d)(?![\d万亿w])", sup_norm) is not None


def _check_numbers(text: str, sup_norm: str, checks: list[dict], where: str, *, annotate: bool = False) -> str:
    """核对高信号量化数字/百分比；对不上时记入 checks，必要时就地标「待确认」。"""
    if not text or not sup_norm:
        return text or ""
    # 排除时间戳与说话人编号中的数字
    scrub = TS_RE.sub(lambda m: " " * len(m.group(0)), text)
    scrub = _SPK_LABEL_RE.sub(lambda m: " " * len(m.group(0)), scrub)
    matches = list(_QTY_RE.finditer(scrub))
    if not matches:
        return text
    bad_ends: list[int] = []
    seen_tok: set[str] = set()
    for m in matches:
        num, unit = m.group(1), m.group(2)
        tok = text[m.start():m.end()]
        # 已自带待确认标记的不重复标注
        tail = text[m.end():m.end() + 10]
        if "待确认" in tail:
            continue
        if _num_supported(num, unit, sup_norm):
            continue
        if tok not in seen_tok:
            seen_tok.add(tok)
            checks.append({"kind": "number", "where": where, "from": tok, "to": f"{tok}（待确认）",
                           "reason": "转写里没有这个数字"})
        bad_ends.append(m.end())
    if not annotate or not bad_ends:
        return text
    out = []
    pos = 0
    for b in bad_ends:
        out.append(text[pos:b])
        out.append("（待确认）")
        pos = b
    out.append(text[pos:])
    return "".join(out)


HL_MAX = 12  # 要点最多几条
HL_SPAN_MAX = 180000  # 一条要点的来源最长 3 分钟，再长就缩到这个长度


def build_highlights(raw_list, paras: list[dict], checks: list[dict], *,
                     norms: list[str] | None = None, full_num_norm: str = "") -> list[dict]:
    """要点：每条带来源时间范围 {text, start_ms, end_ms, quote, verified}。
    起点按原话校正；时间对不上转写的保留文字但不给跳转（verified=False）。"""
    out = []
    last = max((p.get("end", p["start"]) for p in paras), default=0)
    for raw in (raw_list if isinstance(raw_list, list) else [])[:HL_MAX * 2]:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()[:120]
        if not text:
            continue
        quote = str(raw.get("quote") or "").strip()
        ts0 = parse_ts(raw.get("start") if raw.get("start") is not None else raw.get("time"))
        ts, status, hit, hit_idx = _fix_time_hit(ts0, quote, paras, norms)
        if status == "corrected":
            checks.append({"kind": "time", "where": text, "from": fmt(ts0), "to": fmt(ts), "reason": "要点的时间戳改到了原话所在的位置"})
        if status in ("missing", "empty") or ts is None:
            if status == "missing":
                checks.append({"kind": "time", "where": text, "from": fmt(ts0), "to": "无出处", "reason": "要点的时间对不上转写"})
            if full_num_norm:
                _check_numbers(text, full_num_norm, checks, text, annotate=False)
            out.append({"text": text, "start_ms": None, "end_ms": None, "quote": quote, "verified": False})
            continue
        end = parse_ts(raw.get("end"))
        floor = max(ts, (hit or {}).get("end", ts))
        if end is None or end <= ts:
            end = floor if floor > ts else ts + 15000
        end = min(max(end, floor), ts + HL_SPAN_MAX)
        end = max(ts, min(end, last or end))
        if full_num_norm:
            sup = _norm_nums(support_text(paras, ts, quote, hit_idx=hit_idx, norms=norms)) or full_num_norm
            _check_numbers(text, sup, checks, text, annotate=False)
        out.append({"text": text, "start_ms": ts, "end_ms": end, "quote": quote, "verified": True})
        if len(out) >= HL_MAX:
            break
    out.sort(key=lambda h: (h["start_ms"] is None, h["start_ms"] or 0))
    return out


def build(text: str, paras: list[dict], *, speakers: dict | None = None, notes: str = "") -> tuple[dict, list[dict]]:
    """解析模型的 JSON，核对后返回可渲染的结构和改动列表。解析失败抛 ValueError。"""
    doc = parse_json(text)
    checks: list[dict] = []
    norms = [norm(p.get("text") or "") for p in paras]
    blob = "".join(norms)
    known_spks = _known_speakers(speakers)
    notes_num_norm = _norm_nums(notes) if notes else ""
    paras_num_norm = _norm_nums("\n".join(p.get("text") or "" for p in paras))
    full_num_norm = "\n".join(x for x in (paras_num_norm, notes_num_norm) if x)

    # 概要与各小节直接核对全文（含笔记），避免单条时间戳把多条目小节的其他真实数据误判为无出处
    summary = mark_times(str(doc.get("summary") or "").strip(), paras, checks, "会议概要")
    summary = _check_numbers(summary, full_num_norm, checks, "会议概要", annotate=True)
    sections = []
    for sec in doc.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        heading = str(sec.get("heading") or "").strip()[:40]
        if not heading:
            continue
        body = mark_times(str(sec.get("body") or "").strip(), paras, checks, heading)
        body = _check_numbers(body, full_num_norm, checks, heading, annotate=True)
        sections.append({"heading": heading, "body": body})
    actions = []
    for raw in (doc.get("actions") or [])[:40]:
        if not isinstance(raw, dict):
            continue
        task = str(raw.get("task") or "").strip()
        if not task:
            continue
        quote = str(raw.get("quote") or "").strip()
        ts0 = parse_ts(raw.get("time"))
        ts, status, _, hit_idx = _fix_time_hit(ts0, quote, paras, norms)
        if status == "corrected":
            checks.append({"kind": "time", "where": task, "from": fmt(ts0), "to": fmt(ts), "reason": "时间戳改到了原话所在的位置"})
        elif status == "missing":
            checks.append({"kind": "time", "where": task, "from": fmt(ts0), "to": time_label(ts0, status), "reason": "这个时间对不上转写"})
        owner, onote = _owner(str(raw.get("owner") or ""), paras, blob=blob, known_spks=known_spks)
        if onote:
            checks.append({"kind": "owner", "where": task, "to": owner, **onote})
        support = support_text(paras, ts if status != "missing" else ts0, quote, hit_idx=hit_idx, norms=norms)
        due, dnote = _due(str(raw.get("due") or ""), support)
        if dnote:
            checks.append({"kind": "due", "where": task, "to": due, **dnote})
        act_sup = "\n".join(x for x in (_norm_nums(support), notes_num_norm) if x) or full_num_norm
        _check_numbers(task, act_sup, checks, task, annotate=False)
        actions.append({"task": task, "owner": owner, "due": due, "time": time_label(ts if status != "missing" else ts0, status),
                        "quote": quote})
    keywords = []
    for k in doc.get("keywords") or []:
        k = str(k).strip()
        if k and k not in keywords:
            keywords.append(k)
        if len(keywords) >= 10:
            break
    title = str(doc.get("title") or "会议纪要").strip().lstrip("#").strip()[:40] or "会议纪要"
    highlights = build_highlights(doc.get("highlights"), paras, checks, norms=norms, full_num_norm=full_num_norm)
    return {"title": title, "summary": summary, "sections": sections, "actions": actions, "keywords": keywords,
            "highlights": highlights}, checks


def _cell(s: str) -> str:
    return str(s or "").replace("|", "｜").replace("\n", " ")


def _cite(label: str) -> str:
    label = label or ""
    m = re.match(r"(\d{1,2}:\d{2}(?::\d{2})?)(.*)$", label)
    if m:
        return f"[{m.group(1)}]{m.group(2)}"
    return label


def should_auto_refresh(mn: dict | None, *, from_live: bool = False, transcript_changed: bool = False) -> bool:
    """精准转写落地后，要不要自动重写纪要。

    手改过的不覆盖。实时稿生成的（from_live），或记录的转写指纹和现在的转写对不上，要重写。
    只改了笔记、转写没变，不在这里重写。
    """
    if not isinstance(mn, dict) or mn.get("edited"):
        return False
    if from_live:
        return True
    return bool(transcript_changed)


def _heading_key(heading: str) -> str:
    text = re.sub(r"^#+\s*", "", heading or "").strip()
    return re.sub(r"\s+", "", text).strip("：:")


def _dedupe_sections(sections: list[dict], summary_heading: str) -> list[dict]:
    """去掉和概要同名的小节，以及连续重复的标题。留下先出现的那一节。"""
    summary_key = _heading_key(summary_heading)
    out = []
    for sec in sections:
        if not isinstance(sec, dict):
            continue
        key = _heading_key(str(sec.get("heading") or ""))
        if not key or key == summary_key:
            continue
        if out and _heading_key(str(out[-1].get("heading") or "")) == key:
            continue
        out.append(sec)
    return out


def dedupe_markdown_headings(md: str) -> str:
    """渲染结果里连续两个相同的二级标题只留前面一节。"""
    parts = re.split(r"(?m)^(## .+)$", md or "")
    if len(parts) < 3:
        return md or ""
    pre, chunks, i = parts[0], [], 1
    while i + 1 < len(parts):
        heading, body = parts[i], parts[i + 1]
        if chunks and _heading_key(chunks[-1][0]) == _heading_key(heading):
            i += 2
            continue
        chunks.append((heading, body))
        i += 2
    return pre + "".join(heading + body for heading, body in chunks)


_ACTION_HEADING = {"weekly": "下周计划与待办", "client": "后续跟进", "brainstorm": "下一步行动"}
_SUMMARY_HEADING = {"client": "沟通概要", "interview": "面试概要", "lecture": "内容概要", "brainstorm": "讨论主题"}
_TABLE_TEMPLATES = {"general", "weekly", "client", "brainstorm"}


def render(doc: dict, template_id: str = "general") -> str:
    summary_h = _SUMMARY_HEADING.get(template_id, "会议概要")
    sections = _dedupe_sections(doc.get("sections") or [], summary_h)
    lines = [f"# {doc.get('title') or '会议纪要'}", "",
             f"## {summary_h}",
             (doc.get("summary") or "（无）").strip(), ""]
    for sec in sections:
        lines += [f"## {sec.get('heading')}", (sec.get("body") or "（无）").strip(), ""]
    actions = doc.get("actions") or []
    if actions or template_id in _TABLE_TEMPLATES:
        lines += [f"## {_ACTION_HEADING.get(template_id, '待办事项')}", "",
                  "| 事项 | 负责人 | 截止时间 | 出处 |", "|---|---|---|---|"]
        if not actions:
            lines.append("| （无） | 待定 | 待定 | |")
        for a in actions:
            lines.append("| " + " | ".join(_cell(x) for x in (a.get("task"), a.get("owner"), a.get("due"), _cite(a.get("time") or ""))) + " |")
        lines.append("")
    if doc.get("keywords"):
        lines += ["## 关键词", "、".join(doc["keywords"]), ""]
    return dedupe_markdown_headings("\n".join(lines).strip() + "\n")
