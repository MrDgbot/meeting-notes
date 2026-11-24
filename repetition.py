"""收掉语音识别的复读循环。

远场、噪声、背景音乐时，解码器会把一个短语重复几十上百遍（「内部转岗，内部转岗，…」）。
这是幻觉，不是说话人真的说了那么多遍。两到三遍的自然重复（「对对对」「走走走」「45啊，45啊，45啊」）保留。

另外两类也收：
- 同一个字连着写满 7 遍及以上，收成 3 遍（「尔」×10 → 「尔尔尔」）。6 遍及以内不动（「对对对对对。」「说说说说」「哈哈哈哈哈哈」）。
- 同一段里，去掉标点后满 12 个字的分句如果和前面某一分句逐字相同，删掉后面这次以及它自带的标点。
  分句按 ，。！？；,.!?; 切开。不满 12 个字的分句不删。删完如果会留下两个标点，只留一个；
  被删的分句本身是一句的结尾时，前一个分句改用这个句末标点（。！？等），避免句子被逗号切断。

只在文字上收束，不改时间戳：一段话的起止仍盖住原来的音频。
已经收过的文本再跑一遍不变。
Nemotron 只做说话人区分、不产生文字；Nano、Paraformer、豆包的文字都从这里过。
"""

_PUNCT = "，。！？、；：,.!?;: \n\t　"
_CLAUSE_PUNCT = "，。！？；,.!?;"
_SENTENCE_END = "。！？.!?"


def _content(unit: str) -> str:
    return "".join(ch for ch in unit if ch not in _PUNCT)


def _is_runaway(content: str, count: int) -> bool:
    n = len(content)
    if n >= 4 and count >= 4:
        return True
    if n >= 2 and count >= 6:
        return True
    return False


def _collapse_char_runs(text: str) -> str:
    """同一个非标点字连续出现 7 次及以上，收成 3 次。"""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in _PUNCT:
            out.append(ch)
            i += 1
            continue
        j = i + 1
        while j < n and text[j] == ch:
            j += 1
        run = j - i
        out.append(ch * (3 if run >= 7 else run))
        i = j
    return "".join(out)


def _collapse_phrases(text: str) -> str:
    """把连续重复的短语收成两遍。"""
    out: list[str] = []
    i, n = 0, len(text)
    max_l = 24
    while i < n:
        best = None  # (覆盖长度, 单元长度, 单元, 去掉标点后的正文, 末尾再吃掉的字数)
        ch0 = text[i]
        upper = min(max_l, (n - i) // 4)
        for length in range(2, upper + 1):
            if text[i + length] != ch0:
                continue
            unit = text[i:i + length]
            if text[i + length:i + 2 * length] != unit:
                continue
            content = _content(unit)
            # 四字及以上连着四遍，或两字及以上连着六遍，才算失控。两到三遍一律保留。
            need = 4 if len(content) >= 4 else 6
            if len(content) < 2 or i + length * need > n:
                continue
            count = 2
            while i + (count + 1) * length <= n and text[i + count * length:i + (count + 1) * length] == unit:
                count += 1
            if not _is_runaway(content, count):
                continue
            end = i + count * length
            extra = 0
            rest = text[end:]
            if content and rest.startswith(content):
                nxt = rest[len(content):len(content) + 1]
                extra = len(content)
                # 最后一遍如果只少了和前面一样的标点，把这个标点也吃掉，避免再留出第三遍
                if nxt and nxt in _PUNCT and unit.endswith(nxt):
                    extra += 1
            span = end - i + extra
            if best is None or span > best[0] or (span == best[0] and length < best[1]):
                best = (span, length, unit, content, extra)
        if best:
            span, _length, unit, content, _extra = best
            if unit[-1] in _PUNCT:
                out.append(unit + content)  # 「内部转岗，」+「内部转岗」
            else:
                out.append(unit * 2)
            i += span
        else:
            out.append(ch0)
            i += 1
    return "".join(out)


def _drop_repeated_clauses(text: str) -> str:
    """同一段里后出现的长分句，和前面某一分句逐字相同就删掉。"""
    parts: list[list[str]] = []
    i, n = 0, len(text)
    while i < n:
        j = i
        while j < n and text[j] not in _CLAUSE_PUNCT:
            j += 1
        punct = text[j] if j < n else ""
        parts.append([text[i:j], punct])
        i = j + 1 if punct else j
    seen: set[str] = set()
    kept: list[list[str]] = []
    for body, punct in parts:
        if len(_content(body)) >= 12 and body in seen:
            # 被删的分句是句末时，句号留给前一个分句，不和它原来的逗号叠成两个标点
            if punct in _SENTENCE_END and kept:
                kept[-1][1] = punct
            continue
        if len(_content(body)) >= 12:
            seen.add(body)
        kept.append([body, punct])
    return "".join(body + punct for body, punct in kept)


def collapse_repetition(text: str) -> str:
    """收掉复读。已经收过的文本再跑一遍不变。"""
    if not text:
        return text or ""
    # 单字先收。否则「啊」连写十几遍会被当成两字短语，收成四遍而不是三遍。
    text = _collapse_char_runs(text)
    text = _collapse_phrases(text)
    text = _drop_repeated_clauses(text)
    return text
