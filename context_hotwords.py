"""把这场会议的上下文和词库合成热词。

优先级：本场额外热词、常用词库、参会人姓名、标题和笔记里的专名、以往会议里反复出现的专名。
总数有上限。Fun-ASR-Nano 和 Paraformer 能把这份列表当热词；豆包接口不接受热词，调用方改走转写后的纠错。
"""
import hashlib
import re
import threading
from collections import OrderedDict

import jieba
import jieba.posseg as pseg

import vocab

MAX_HOTWORDS = 30
MAX_TERM = 16
# jieba 的人名、地名、机构、其他专名
PROPER_FLAGS = {"nr", "nrt", "nrfg", "ns", "nt", "nz", "eng"}
STOP = set("我们 你们 他们 这个 那个 什么 怎么 可以 然后 就是 一个 没有 不是 因为 所以 如果 已经 开始 "
           "问题 时间 工作 会议 今天 现在 自己 还有 以及 进行 需要 希望 觉得 知道 谢谢 大家好 各位".split())
# 仅作用于自动抽取来源（标题/笔记/历史）的非专名高频噪声词：
# 包含 jieba 容易误标为 nr/ns/nz 的日常词，以及易诱发 Fun-ASR-Nano CTC 幻觉拦截的口语词。
AUTO_NOISE_WORDS = frozenset(
    "东西 宝贵 英语 中文 英文 英文名 日语 韩语 法语 汉语 普通话 关联 入口 出口 明白 清楚 汇报 普通 普通员工 维度 "
    "白名单 黑名单 和平 公正 诚信 文明 美丽 多少钱 太多 太少 很多 没问题 没关系 好的 可以的 不错 "
    "方便 麻烦 重要 正常 异常 简单 复杂 之前 之后 以前 以后 目前 最近 刚刚 马上 立刻 暂时 长期 短期 "
    "方面 方式 方法 方案 方向 情况 条件 原因 结果 效果 建议 意思 意义 关系 联系 合作 交流 沟通 讨论 "
    "确认 解决 处理 安排 计划 目标 任务 需求 功能 版本 内容 信息 资源 流程 标准 规范 规则 策略 逻辑 "
    "部分 全部 整体 细节 重点 核心 关键 基础 背景 现状 趋势 成本 价值 收益 效率 质量 体验 安全 稳定".split()
)
# 常见英文口语填充词与停用词（大小写不敏感，例如 OK/ok、yes、the、and 等）
EN_STOP = frozenset(
    "ok okay yes no hi hey hello bye thanks thank please sorry good nice fine well sure right yeah yep nope "
    "the and for are but not you your all any can was were one two our out day get got has had her his him she "
    "how its may new now old see way who why did does let put say said too use used this that with from they "
    "them their there here have been will what when where which about would could should just like more some "
    "than then into only also very much most such over back even still after before other being doing going "
    "think know want need make take come give look work time year people thing things really actually maybe "
    "already always never again because since while though however anyway basically probably first second "
    "third last next today tomorrow yesterday week month hour minute check keep done find show tell call try "
    "ask feel help talk start stop move open wait send".split()
)
# 2 字母英文停用词：非全大写时过滤（拦截 it/It/to/in/of/so/or/us，保留全大写缩写 IT/US/OR/AI/BI/QA）
EN_SHORT_LOWER_STOP = frozenset(
    "is it to in on at of by as if up do go be we he me my us an am so or oh ah um uh ha".split()
)
ORDINAL_NOISE_RE = re.compile(r"^第[一二三四五六七八九十百千万两\d]+[版期批轮次步天周月年个条款项部分章页节]$")
TIME_NOISE_RE = re.compile(
    r"^(今天|明天|昨天|前天|后天|大前天|大后天|今日|明日|昨日|本周|上周|下周|这周|本月|上月|下月)"
    r"(早上|上午|中午|下午|傍晚|晚上|晚间|凌晨|早晨)?$"
)
AUTO_TITLE = re.compile(r"^(会议|自动记录)\b")
GENERIC_NAME = re.compile(r"说话人\s*\d+")
QUOTED = re.compile(r"[「“\"]([^」”\"]{2,16})[」”\"]")
EN = re.compile(r"[A-Za-z][A-Za-z0-9_+.-]{1,15}")

_PN_LOCK = threading.Lock()
_PN_CACHE: OrderedDict[tuple[int, str], tuple[str, ...]] = OrderedDict()
_PN_MAX = 256
_PSEG_LOCK = threading.Lock()
_pseg_ready = False


def _ensure_pseg() -> None:
    global _pseg_ready
    if _pseg_ready:
        return
    with _PSEG_LOCK:
        if not _pseg_ready:
            list(pseg.cut("初始化"))
            _pseg_ready = True


def _clean(term: str) -> str:
    term = (term or "").strip().strip(".,，。、；;：:！!？?")
    if not term or len(term) > MAX_TERM or len(term) < 2:
        return ""
    if term in STOP or GENERIC_NAME.fullmatch(term):
        return ""
    if re.fullmatch(r"[\d\W_]+", term):
        return ""
    return term


def _key(term: str) -> str:
    return term.lower()


def _is_auto_noise(term: str) -> bool:
    """判断自动抽取出的候选词是否为日常非专名噪声词（不拦截用户显式热词与参会人名）。"""
    if not term:
        return True
    if term in AUTO_NOISE_WORDS or ORDINAL_NOISE_RE.fullmatch(term) or TIME_NOISE_RE.fullmatch(term):
        return True
    low = term.lower()
    if low in EN_STOP:
        return True
    if len(term) == 2 and not term.isupper() and low in EN_SHORT_LOWER_STOP:
        return True
    return False


def proper_nouns(text: str) -> list[str]:
    """从一段文字里抽出像专名的词。同一段里按出现顺序去重。结果按内容哈希 LRU 缓存。"""
    if not (text or "").strip():
        return []
    key = (len(text), hashlib.sha1(text.encode("utf-8")).hexdigest())
    with _PN_LOCK:
        cached = _PN_CACHE.get(key)
        if cached is not None:
            _PN_CACHE.move_to_end(key)
            return list(cached)
    _ensure_pseg()
    found: list[str] = []
    seen = set()

    def add(raw: str):
        term = _clean(raw)
        if not term or _is_auto_noise(term):
            return
        k = _key(term)
        if k in seen:
            return
        seen.add(k)
        found.append(term)

    for m in QUOTED.finditer(text):
        add(m.group(1))
    for m in EN.finditer(text):
        add(m.group(0))
    for w in pseg.cut(text):
        if w.flag in PROPER_FLAGS:
            add(w.word)
    result = tuple(found)
    with _PN_LOCK:
        _PN_CACHE[key] = result
        _PN_CACHE.move_to_end(key)
        while len(_PN_CACHE) > _PN_MAX:
            _PN_CACHE.popitem(last=False)
    return found


def merge_hotwords(user: list[str], title: str = "", title_auto: bool = False, speakers: dict | None = None,
                   notes: str = "", history: list | None = None, limit: int = MAX_HOTWORDS,
                   gallery_names: list[str] | None = None, demoted: set[str] | None = None) -> list[str]:
    """按优先级合并，先到先得，直到 limit。高优先级词不被低优先级包含它的长串挤掉。

    优先级：用户显式热词 > 本场参会人 > 声纹库常见人名 > 人工标题 > 笔记 > 历史会议（人工确认权重高于原始转写）。
    非用户显式来源（标题/笔记/历史/声纹库）会过滤掉 CTC 高拒绝率的淘汰热词。
    """
    if limit <= 0:
        return []
    if demoted is None:
        try:
            import rsi_vocab
            demoted_keys = {_key(w) for w in rsi_vocab.demoted_hotwords()}
        except Exception:  # noqa: BLE001
            demoted_keys = set()
    else:
        demoted_keys = {_key(w) for w in demoted}

    out: list[str] = []
    seen: set[str] = set()
    tier_of: dict[str, int] = {}

    def add(raw: str, tier: int, *, check_demoted: bool = False, check_noise: bool = False):
        if len(out) >= limit:
            return
        term = _clean(raw)
        if not term:
            return
        if check_noise and _is_auto_noise(term):
            return
        k = _key(term)
        if k in seen:
            return
        if check_demoted and k in demoted_keys:
            return
        # 「长尾」不要和「长尾词」同时进列表：短的那个更容易被硬塞进听不清的地方；
        # 但低优先级来源（标题、笔记、历史）不得挤掉更高优先级（如用户显式热词）
        for prev in list(seen):
            if prev != k and (prev in k or k in prev):
                if len(prev) >= len(k) or tier > tier_of.get(prev, 0):
                    return
                seen.discard(prev)
                tier_of.pop(prev, None)
                out[:] = [w for w in out if _key(w) != prev]
        seen.add(k)
        tier_of[k] = tier
        out.append(term)

    for w in user:
        add(w, 0)
    if len(out) >= limit:
        return out
    for name in (speakers or {}).values():
        add(str(name), 1)
    if len(out) >= limit:
        return out
    if gallery_names is None:
        try:
            import voiceprints
            gallery_names = voiceprints.known_names()
        except Exception:  # noqa: BLE001
            gallery_names = []
    for name in gallery_names or []:
        add(str(name), 2, check_demoted=True)
    if len(out) >= limit:
        return out
    if title and not title_auto and not AUTO_TITLE.match(title.strip()):
        for w in proper_nouns(title):
            add(w, 3, check_demoted=True, check_noise=True)
        if len(title.strip()) <= 12:
            add(title.strip(), 3, check_demoted=True, check_noise=True)
    if len(out) >= limit:
        return out
    for w in proper_nouns(notes):
        add(w, 4, check_demoted=True, check_noise=True)
    if len(out) >= limit or not history:
        return out
    scores: dict[str, float] = {}
    verified: dict[str, bool] = {}
    display: dict[str, str] = {}
    order: dict[str, int] = {}
    idx = 0
    for item in history:
        if isinstance(item, str):
            text, weight, is_ver = item, 1.0, False
        elif isinstance(item, tuple) and len(item) >= 2:
            text, weight = str(item[0] or ""), float(item[1] or 1.0)
            is_ver = bool(item[2]) if len(item) >= 3 else (weight >= 2.0)
        elif isinstance(item, dict):
            text = str(item.get("text") or "")
            weight = float(item.get("weight") or 1.0)
            is_ver = bool(item.get("verified", weight >= 2.0))
        else:
            continue
        if not text.strip() or weight <= 0:
            continue
        for w in set(proper_nouns(text)):
            k = _key(w)
            scores[k] = scores.get(k, 0.0) + weight
            verified[k] = verified.get(k, False) or is_ver
            display.setdefault(k, w)
            if k not in order:
                order[k] = idx
                idx += 1
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], not verified.get(kv[0], False), order.get(kv[0], 0)))
    for k, sc in ranked:
        if sc < 2.0 or len(out) >= limit:
            break
        add(display[k], 5, check_demoted=True, check_noise=True)
    return out


def for_meeting(meta: dict, notes: str, history: list, vocab_hotwords: str) -> str:
    """一场会议实际送给识别的热词串。vocab_hotwords 是词库里的常用热词，不含本场额外词。"""
    user = vocab.split_words(vocab_hotwords) + vocab.split_words(meta.get("hotword") or "")
    words = merge_hotwords(user, title=meta.get("title") or "", title_auto=bool(meta.get("title_auto")),
                           speakers=meta.get("speakers") or {}, notes=notes or "", history=history)
    return " ".join(words)


def _apply_hits(text: str, hits: list[dict]) -> str:
    if not hits:
        return text
    mapping: dict[str, str] = {}
    for hit in sorted(hits, key=lambda h: len(h["text"]), reverse=True):
        mapping.setdefault(hit["text"], hit["hotword"])
    pat = re.compile("|".join(re.escape(k) for k in mapping))
    return pat.sub(lambda m: mapping[m.group(0)], text)


def make_lexicon_corrector(hotword: str):
    """预先解析热词与读音，返回可复用的纠错函数，避免批量逐段重复计算。"""
    if not (hotword or "").strip():
        return lambda text: text or ""
    prepped = vocab.prepare_suspects(hotword)
    if not prepped:
        return lambda text: text or ""

    def correct(text: str) -> str:
        text = text or ""
        if not text.strip():
            return text
        return _apply_hits(text, vocab.suspects_with([{"text": text, "start": 0}], prepped))

    return correct


def correct_by_lexicon(text: str, hotword: str) -> str:
    """模型不接受热词时，用和「可能认错的热词」同一套条件，在转写后把读音对得上的说法改过来。

    只替换 3–8 个汉字、读音像热词、又不是常用词的片段。改不了的保持原样。
    """
    text = text or ""
    if not text.strip() or not (hotword or "").strip():
        return text
    return make_lexicon_corrector(hotword)(text)


# 让 jieba 的初始化日志别打出来；第一次切词时再加载词典
jieba.setLogLevel(20)
