"""词库：常用热词（帮助识别）+ 纠错规则（识别后把固定的错写替换成正确写法，如“艾森 → ASIN”）。

纠错在读取转写时套用，不改原始转写：新加的规则对旧记录也立刻生效，删掉规则即恢复原样。
"""
import re
import threading

import store

PATH = store.DATA / "vocab.json"
_lock = threading.Lock()
_cache: dict = {"mtime": None, "vocab": None, "rules": None}
# 模型常把缩写拆成单个字母输出（“S K U”“C P U”），拼回去；读取时也套用，旧记录一并生效
SPELLED_RE = re.compile(r"(?<![A-Za-z])([A-Z]) (?=[A-Z](?![A-Za-z]))")
def split_words(s: str) -> list[str]:
    return [w for w in re.split(r"[\s,，、;；]+", s or "") if w]


def _load() -> tuple[dict, list]:
    mtime = PATH.stat().st_mtime if PATH.exists() else None
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
    长度相同时保留优先。"""
    if not fixes:
        return None
    alts = []  # (长度, 保留优先, 正则片段, 替换文本或 None)
    for f in fixes:
        a = f["from"]
        pre = r"(?<![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", a) else ""
        post = r"(?![A-Za-z0-9])" if re.search(r"[A-Za-z0-9]$", a) else ""
        alts.append((len(a), 1, f"(?i:{pre}{re.escape(a)}{post})", f["to"]))
        if f["to"]:
            alts.append((len(f["to"]), 0, re.escape(f["to"]), None))
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


def apply(text: str) -> str:
    _, rules = _load()
    text = SPELLED_RE.sub(r"\1", text or "")
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


def apply_paras(paras: list[dict]) -> list[dict]:
    """手动改过的段落（edited）不再套纠错规则：用户改成什么就是什么（例如把被规则改成 ASIN 的人名“艾森”改回来）。"""
    return [p if p.get("edited") else {**p, "text": apply(p.get("text", ""))} for p in paras]


# ---------------- 疑似认错的热词 ----------------
# 憨包云端识别不接受热词（试过几种传法都没有效果），热词只在本机补识别时有用；
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
    if not _seg:
        import logging

        import jieba
        from pypinyin import Style, lazy_pinyin, pinyin
        jieba.setLogLevel(logging.ERROR)
        jieba.initialize()
        _seg.update(jieba=jieba, freq=jieba.dt.FREQ, lazy=lazy_pinyin,
                    readings=lambda w: [r[:3] for r in pinyin(w, style=Style.NORMAL, heteronym=True)])
    return _seg


def _sounds_like(readings: list[list[str]], cand: str) -> bool:
    edits, tot = [], 0
    for rs, b in zip(readings, _tools()["lazy"](cand)):
        e, a = min((_lev(a, b), a) for a in rs)  # 多音字取最接近的读法（“长”有 chang / zhang）
        if e > max(len(a), len(b)) / 2:
            return False
        edits.append(e)
        tot += max(len(a), len(b))
    return 0 in edits and sum(edits) <= SUSPECT_RATIO * tot


def suspects(paras: list[dict], extra_hot: str = "") -> list[dict]:
    """转写里读音像热词、又不是常用词的说法。返回 [{"hotword", "text", "count", "at": [开始ms…]}]，按次数排序。
    传入的段落应已套过纠错规则：已经有规则的错写不会再出现。"""
    hot = [h for h in split_words(hotwords(extra_hot)) if re.fullmatch(r"[\u4e00-\u9fff]{3,8}", h)]
    if not hot or not paras:
        return []
    t = _tools()
    found: dict = {}
    for p in paras:
        for run in _CJK.findall(p.get("text", "")):
            if len(run) < 3:
                continue
            toks = t["jieba"].lcut(run)
            pos = [0]
            for x in toks:
                pos.append(pos[-1] + len(x))
            for hw in hot:
                n, rd = len(hw), None
                for k, s in enumerate(pos):
                    if s + n not in pos[k + 1:]:
                        continue
                    e = pos.index(s + n)
                    c = run[s:s + n]
                    if c == hw or any(len(x) >= 2 and x in t["freq"] for x in toks[k:e]) or any(c in h or h in c for h in hot):
                        continue
                    rd = rd or t["readings"](hw)
                    if _sounds_like(rd, c):
                        f = found.setdefault((hw, c), {"hotword": hw, "text": c, "count": 0, "at": []})
                        f["count"] += 1
                        if len(f["at"]) < 5:
                            f["at"].append(p["start"])
    return sorted(found.values(), key=lambda f: -f["count"])
