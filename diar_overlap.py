"""重叠说话：帧级概率收成可重叠的时间段，并在「谁在说话」发生变化的地方切开文字。

CAM++ 的时间段互不重叠，原有的按多数人归属不变。Nemotron 3 允许同一时刻多人，这里才切开。
"""
import numpy as np


def turns_overlap(turns, start=None, end=None) -> bool:
    """有没有两个不同的人在同一时刻都算在说话。给了 start/end 就只看这一段。"""
    spans = []
    for a, b, s in turns or []:
        if end is not None and a >= end:
            continue
        if start is not None and b <= start:
            continue
        if b > a:
            spans.append((a, b, s))
    spans.sort()
    active: list[tuple] = []
    for a, b, s in spans:
        active = [x for x in active if x[0] > a]
        if any(spk != s for _, spk in active):
            return True
        active.append((b, s))
    return False


def remap_arrival(turns) -> list[tuple]:
    """按第一次开口的先后把说话人编号改成 0、1、2…"""
    order: dict = {}
    out = []
    for a, b, s in sorted(turns, key=lambda t: (t[0], t[2])):
        out.append((int(a), int(b), order.setdefault(s, len(order))))
    return out


def limit_speakers(turns, n: int) -> list[tuple]:
    """用户指定了人数时，只留说得最久的 n 个人，再按出现顺序重新编号。"""
    if not n or int(n) <= 0:
        return remap_arrival(turns)
    dur: dict = {}
    for a, b, s in turns:
        dur[s] = dur.get(s, 0) + max(0, b - a)
    keep = {k for k, _ in sorted(dur.items(), key=lambda kv: (-kv[1], kv[0]))[: int(n)]}
    return remap_arrival([t for t in turns if t[2] in keep])


def probs_to_turns(probs, hop_ms: int = 10, onset: float = 0.5, min_ms: int = 200, gap_ms: int = 100) -> list[tuple]:
    """probs 形状 [帧, 说话人]，每个值是这个人在这一帧说话的概率。

    连续不低于 onset 的帧收成一段。短于 min_ms 的丢掉，中间空档短于 gap_ms 的接上。
    不同人的段可以重叠。
    """
    p = np.asarray(probs, dtype=np.float64)
    if p.ndim != 2 or p.size == 0:
        return []
    frames, speakers = p.shape
    hop = max(1, int(hop_ms))
    min_frames = max(1, int(round(min_ms / hop)))
    gap_frames = max(0, int(round(gap_ms / hop)))
    raw = []
    on = p >= onset
    for s in range(speakers):
        col = on[:, s]
        i = 0
        while i < frames:
            if not col[i]:
                i += 1
                continue
            j = i + 1
            while j < frames and col[j]:
                j += 1
            while True:
                g = j
                while g < frames and not col[g]:
                    g += 1
                if g < frames and g - j <= gap_frames and col[g]:
                    j = g + 1
                    while j < frames and col[j]:
                        j += 1
                    continue
                break
            if j - i >= min_frames:
                raw.append((i * hop, j * hop, s))
            i = max(j, i + 1)
    return remap_arrival(raw)


def _active(turns, ms: float) -> tuple:
    found = []
    for a, b, s in turns:
        if a <= ms < b and s not in found:
            found.append(s)
    return tuple(found)


def _nearest(turns, ms: float) -> tuple:
    best = min(turns, key=lambda t: min(abs(t[0] - ms), abs(t[1] - ms)))
    return (best[2],)


def _overlap_item(sent, turns) -> list[dict]:
    """没有逐字时间时，整句看重叠比例。第二个人占到四分之一以上就标上。"""
    s, e = sent[0]["start"], sent[-1]["end"]
    dur = max(1, e - s)
    ov: dict = {}
    for a, b, spk in turns:
        o = min(e, b) - max(s, a)
        if o > 0:
            ov[spk] = ov.get(spk, 0) + o
    ranked = [k for k in sorted(ov, key=lambda k: -ov[k]) if ov[k] >= 0.25 * dur]
    if len(ranked) <= 1:
        return sent
    text = "".join(c["text"] for c in sent)
    return [{"start": s, "end": e, "text": text, "spk": ranked[0], "spks": ranked,
             "ct": [t for c in sent for t in (c.get("ct") or [])]}]


def split_sentence(sent: list[dict], turns: list[tuple], min_ms: float) -> list[dict]:
    """一句话按逐字时间切开。每个字看中点时刻有哪些人在说话，连续同一组人的字合成一段。

    短于 min_ms 的段并进旁边更长的那段，说话人集合并起来。只有一个人时不写 spks。
    """
    chars = []
    for c in sent:
        text = c.get("text") or ""
        ct = list(c.get("ct") or [])
        if len(ct) < len(text):
            ct = ct + [None] * (len(text) - len(ct))
        chars += list(zip(text, ct))
    if not chars or not turns:
        return sent

    def lab_of(t):
        if not t:
            return None
        mid = (t[0] + t[1]) / 2
        return _active(turns, mid) or _nearest(turns, mid)

    labs, prev = [], None
    for _, t in chars:
        if t:
            prev = lab_of(t)
        labs.append(prev)
    first = next((v for v in labs if v), None)
    if first is None:
        return _overlap_item(sent, turns)
    labs = [first if v is None else v for v in labs]
    runs = []  # [说话人元组, 起始字, 结束字)
    for i, v in enumerate(labs):
        if runs and runs[-1][0] == v:
            runs[-1][2] = i + 1
        else:
            runs.append([v, i, i + 1])

    def dur(r) -> int:
        ts = [t for _, t in chars[r[1]:r[2]] if t]
        return ts[-1][1] - ts[0][0] if ts else 0

    while len(runs) > 1 and min_ms and min_ms > 0:
        short = [k for k in range(len(runs)) if dur(runs[k]) < min_ms]
        if not short:
            break
        k = min(short, key=lambda i: dur(runs[i]))
        nb = [j for j in (k - 1, k + 1) if 0 <= j < len(runs)]
        j = max(nb, key=lambda i: dur(runs[i]))
        lo, hi = min(j, k), max(j, k)
        longer = runs[j][0]
        merged = tuple(dict.fromkeys((*longer, *runs[lo][0], *runs[hi][0])))
        runs[lo:hi + 1] = [[merged, runs[lo][1], runs[hi][2]]]
    if len(runs) == 1 and len(runs[0][0]) <= 1:
        return sent
    out = []
    for lab, a, b in runs:
        piece = chars[a:b]
        text = "".join(ch for ch, _ in piece).strip()
        if not text:
            continue
        ts = [t for _, t in piece if t]
        prev_end = out[-1]["end"] if out else sent[0]["start"]
        spks = list(lab)
        item = {"start": ts[0][0] if ts else prev_end, "end": ts[-1][1] if ts else prev_end,
                "text": text, "spk": spks[0] if spks else 0, "ct": [t for _, t in piece]}
        if len(spks) > 1:
            item["spks"] = spks
        out.append(item)
    return out or sent
