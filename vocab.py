"""词库：常用热词（帮助识别）+ 纠错规则（识别后把固定的错写替换成正确写法，如“艾森 → ASIN”）。

纠错在读取转写时套用，不改原始转写：新加的规则对旧记录也立刻生效，删掉规则即恢复原样。
"""
import re
import threading

import repetition
import store

PATH = store.DATA / "vocab.json"
_lock = threading.Lock()
_cache: dict = {"mtime": None, "vocab": None, "rules": None}
# 模型常把缩写拆成单个字母输出（“S K U”“C P U”），拼回去；读取时也套用，旧记录一并生效
SPELLED_RE = re.compile(r"(?<![A-Za-z])([A-Z]) (?=[A-Z](?![A-Za-z]))")
def split_words(s: str) -> list[str]:
    return [w for w in re.split(r"[\s,，、;；]+", s or "") if w]


def invalidate() -> None:
    """清除编译好的词库规则缓存（词库自学习状态变化时调用）。"""
    with _lock:
        _cache.update(mtime=None, vocab=None, rules=None)


def _stat_key():
    try:
        st = PATH.stat()
        vk = (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        vk = None
    rk = None
    try:
        import rsi_vocab
        rk = rsi_vocab.stats_sig()
    except Exception:  # noqa: BLE001
        pass
    return (vk, rk)


def _load() -> tuple[dict, list]:
    mtime = _stat_key()
    with _lock:
        if _cache["vocab"] is None or _cache["mtime"] != mtime:
            v = store.read_json(PATH) or {}
            vocab = {"hotwords": v.get("hotwords", ""),
                     "fixes": [f for f in v.get("fixes", []) if f.get("from")]}
            _cache.update(mtime=mtime, vocab=vocab, rules=_compile(vocab["fixes"]))
        return _cache["vocab"], _cache["rules"]


def _compile(fixes: list[dict]):
    """所有规则编成一个正则，每个位置取最长的匹配：
    - 错写（from）→ 替换成正确写法；英文不分大小写，且不能是更长单词的一部分（“S”不会匹配到“SKU”里）
    - 正确写法（to）本身也是候选，匹配到就原样保留，避免“预算 → 批预算”把“批预算”改成“批批预算”
    长度相同时保留优先。被自学习降级为 suspect_only 的规则跳过自动替换，改在 suspects() 中高亮提示。"""
    if not fixes:
        return None
    skip_fn = None
    try:
        import rsi_vocab
        skip_fn = rsi_vocab.is_suspect_only
    except Exception:  # noqa: BLE001
        pass
    alts = []  # (长度, 保留优先, 正则片段, 替换文本或 None)
    for f in fixes:
        a = f["from"]
        if skip_fn is not None:
            try:
                if skip_fn(a):
                    continue
            except Exception:  # noqa: BLE001
                pass
        pre = r"(?<![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", a) else ""
        post = r"(?![A-Za-z0-9])" if re.search(r"[A-Za-z0-9]$", a) else ""
        alts.append((len(a), 1, f"(?i:{pre}{re.escape(a)}{post})", f["to"]))
        if f["to"]:
            alts.append((len(f["to"]), 0, re.escape(f["to"]), None))
    if not alts:
        return None
    alts.sort(key=lambda t: (-t[0], t[1]))
    pat = re.compile("|".join(f"(?P<g{i}>{p})" for i, (_, _, p, _) in enumerate(alts)))
    return pat, [t[3] for t in alts]


def get() -> dict:
    v, _ = _load()
    return {"hotwords": v["hotwords"], "fixes": [dict(f) for f in v["fixes"]]}


def save(v: dict) -> dict:
    hot = " ".join(dict.fromkeys(split_words(v.get("hotwords", ""))))
    fixes, seen = [], set()
    for f in v.get("fixes") or []:
        a, b = (f.get("from") or "").strip(), (f.get("to") or "").strip()
        if a and a != b and a not in seen:
            fixes.append({"from": a, "to": b})
            seen.add(a)
    store.write_json(PATH, {"hotwords": hot, "fixes": fixes})
    # 有的文件系统上 os.replace 不改 mtime，只靠 mtime 的缓存会一直拿着旧词库
    with _lock:
        _cache.update(mtime=_stat_key(),
                      vocab={"hotwords": hot, "fixes": [dict(f) for f in fixes]}, rules=_compile(fixes))
    return get()


def add_fix(a: str, b: str, hotword: bool = False) -> dict:
    v = get()
    v["fixes"] = [f for f in v["fixes"] if f["from"] != a.strip()] + [{"from": a, "to": b}]
    if hotword and b.strip():
        v["hotwords"] = v["hotwords"] + " " + b.strip()
    return save(v)


def hotwords(extra: str = "") -> str:
    """常用热词 + 本场额外热词，去重。"""
    v, _ = _load()
    return " ".join(dict.fromkeys(split_words(v["hotwords"]) + split_words(extra)))


def _apply_text(text: str, rules) -> str:
    text = repetition.collapse_repetition(text or "")
    text = SPELLED_RE.sub(r"\1", text)
    if not rules or not text:
        return text
    pat, repl = rules

    def sub(m: re.Match) -> str:
        r = repl[int(m.lastgroup[1:])]
        return m.group(0) if r is None else r

    # 多跑几遍让规则可以接力（“家族ASN”→“家族ASIN”→“家族子ASIN”）；最多 3 遍，防止规则互相改来改去
    for _ in range(3):
        new = pat.sub(sub, text)
        if new == text:
            break
        text = new
    return text


def apply(text: str) -> str:
    """纠错规则，外加收掉识别复读。没有纠错规则时也收复读，旧记录打开就能看到。"""
    _, rules = _load()
    return _apply_text(text, rules)


def apply_paras(paras: list[dict]) -> list[dict]:
    """手动改过的段落（edited）不再套纠错规则：用户改成什么就是什么（例如把被规则改成 ASIN 的人名“艾森”改回来）。"""
    _, rules = _load()
    return [p if p.get("edited") else {**p, "text": _apply_text(p.get("text", ""), rules)} for p in paras]


# ---------------- 疑似认错的热词 ----------------
# 豆包云端识别不接受热词（试过几种传法都没有效果），热词只在本机补识别时有用；
# 一场 95 分钟的周会里“长尾词”被认成了“陈伟驰”“常伟奇”，“以图搜图”认成了“你不说图”。
# 这里只找出来给用户确认（一键加纠错规则），不自动改。
# 条件（tests/eval/hotword_suspects.py 调的）：热词 3–8 个汉字；候选和热词字数相同、在分词边界上、里面没有词典里的词（排除“预算是”“那套系统”）；
# 拼音逐字比，至少一个字读音完全相同，每个字改动不超过一半，总改动不超过 30%。
# 实测：那场周会找出 3 处，都是真的认错了；AliMeeting 15 小时转写配 20 个常见业务热词，一处都没误报。
SUSPECT_RATIO = 0.3
_CJK = re.compile(r"[\u4e00-\u9fff]+")
_seg: dict = {}


def _lev(a: str, b: str) -> int:
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (x != y))
    return d[-1]


def _tools():
    global _seg
    if _seg:
        return _seg
    with _lock:
        if not _seg:
            import logging

            import jieba
            from pypinyin import Style, lazy_pinyin, pinyin
            jieba.setLogLevel(logging.ERROR)
            jieba.initialize()
            _seg = {
                "jieba": jieba,
                "freq": jieba.dt.FREQ,
                "lazy": lazy_pinyin,
                "readings": lambda w: [r[:3] for r in pinyin(w, style=Style.NORMAL, heteronym=True)],
            }
    return _seg


def _sounds_like_py(readings: list[list[str]], cand_py: list[str]) -> bool:
    edits, tot = [], 0
    for rs, b in zip(readings, cand_py):
        e, a = min((_lev(a, b), a) for a in rs)  # 多音字取最接近的读法（“长”有 chang / zhang）
        if e > max(len(a), len(b)) / 2:
            return False
        edits.append(e)
        tot += max(len(a), len(b))
    return 0 in edits and sum(edits) <= SUSPECT_RATIO * tot


def _sounds_like(readings: list[list[str]], cand: str) -> bool:
    return _sounds_like_py(readings, _tools()["lazy"](cand))


def prepare_suspects(extra_hot: str = "") -> dict | None:
    """预先解析热词与多音字读音，供批量纠错复用。"""
    hot = [h for h in split_words(hotwords(extra_hot)) if re.fullmatch(r"[\u4e00-\u9fff]{3,8}", h)]
    if not hot:
        return None
    t = _tools()
    by_len: dict[int, list[str]] = {}
    readings: dict[str, list[list[str]]] = {}
    for hw in hot:
        by_len.setdefault(len(hw), []).append(hw)
        readings[hw] = t["readings"](hw)
    return {
        "hot": hot,
        "hot_set": set(hot),
        "by_len": by_len,
        "readings": readings,
        "min_len": min(by_len),
        "tools": t,
    }


def suspects_with(paras: list[dict], prepped: dict | None) -> list[dict]:
    if not prepped or not paras:
        return []
    hot = prepped["hot"]
    hot_set = prepped["hot_set"]
    by_len = prepped["by_len"]
    readings = prepped["readings"]
    min_len = prepped["min_len"]
    t = prepped["tools"]
    freq = t["freq"]
    lazy = t["lazy"]
    lcut = t["jieba"].lcut
    lazy_cache: dict[str, list[str]] = {}
    skip_cache: dict[str, bool] = {}
    dismissed_fn = None
    try:
        import rsi_vocab
        dismissed_fn = rsi_vocab.is_dismissed
    except Exception:  # noqa: BLE001
        pass
    found: dict = {}
    for p in paras:
        for run in _CJK.findall(p.get("text", "")):
            if len(run) < min_len:
                continue
            toks = lcut(run)
            pos = [0]
            dict_ps = [0]
            for x in toks:
                pos.append(pos[-1] + len(x))
                dict_ps.append(dict_ps[-1] + (1 if len(x) >= 2 and x in freq else 0))
            pos_idx = {offset: idx for idx, offset in enumerate(pos)}
            for n, hws in by_len.items():
                if len(run) < n:
                    continue
                for k, s in enumerate(pos):
                    e = pos_idx.get(s + n)
                    if e is None or dict_ps[e] > dict_ps[k]:
                        continue
                    c = run[s:s + n]
                    skip = skip_cache.get(c)
                    if skip is None:
                        skip = c in hot_set or any(c in h or h in c for h in hot)
                        skip_cache[c] = skip
                    if skip:
                        continue
                    py_c = lazy_cache.get(c)
                    if py_c is None:
                        py_c = lazy(c)
                        lazy_cache[c] = py_c
                    for hw in hws:
                        if dismissed_fn is not None:
                            try:
                                if dismissed_fn(hw, c):
                                    continue
                            except Exception:  # noqa: BLE001
                                pass
                        if _sounds_like_py(readings[hw], py_c):
                            f = found.setdefault((hw, c), {"hotword": hw, "text": c, "count": 0, "at": []})
                            f["count"] += 1
                            if len(f["at"]) < 5:
                                f["at"].append(p["start"])
    return sorted(found.values(), key=lambda f: -f["count"])


def suspects(paras: list[dict], extra_hot: str = "") -> list[dict]:
    """转写里读音像热词、又不是常用词的说法，以及被降级为 suspect_only 的纠错规则命中项。
    返回 [{"hotword", "text", "count", "at": [开始ms…]}]，按次数排序。
    传入的段落应已套过纠错规则：仍在生效的规则错写不会再出现。"""
    if not paras:
        return []
    items = suspects_with(paras, prepare_suspects(extra_hot))
    try:
        import rsi_vocab
        v, _ = _load()
        demoted = [
            f for f in (v.get("fixes") or [])
            if f.get("from") and f.get("to")
            and rsi_vocab.is_suspect_only(f["from"])
            and not rsi_vocab.is_dismissed(f["to"], f["from"])
        ]
        if demoted:
            found = {(x["hotword"], x["text"]): x for x in items}
            for f in demoted:
                a, b = f["from"], f["to"]
                pre = r"(?<![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", a) else ""
                post = r"(?![A-Za-z0-9])" if re.search(r"[A-Za-z0-9]$", a) else ""
                pat = re.compile(f"(?i:{pre}{re.escape(a)}{post})")
                for p in paras:
                    hits = len(pat.findall(p.get("text", "")))
                    if hits <= 0:
                        continue
                    rec = found.setdefault((b, a), {"hotword": b, "text": a, "count": 0, "at": [], "from_demoted_rule": True})
                    rec["count"] += hits
                    if len(rec["at"]) < 5:
                        rec["at"].append(p.get("start", 0))
            items = sorted(found.values(), key=lambda f: -f["count"])
    except Exception:  # noqa: BLE001
        pass
    return items
