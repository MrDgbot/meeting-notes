"""录音中的打点：会议目录下的 marks.json，一条 {id, t_ms, label, created}。

t_ms 是录音的音频时间（和转写稿、播放器的时间轴一致）。没有这个文件就是没有打点，老会议不受影响。
生成纪要时，打点前后 WINDOW_MS 的转写作为重点交给模型；导出时附在纪要里。
"""
import secrets
from datetime import datetime

import store
from asr_engine import fmt_ts

NAME = "marks.json"
WINDOW_MS = 30000  # 打点前后各取这么长的转写
DEDUP_MS = 2000  # 连点：离已有打点不到这么近就不再新增
MAX_MARKS = 200
_BLOCK_CHARS = 1200  # 每个打点附近的转写最多取多少字
_TOTAL_CHARS = 12000  # 所有打点合起来最多交给模型多少字


def load(mid: str) -> list[dict]:
    raw = store.load(mid, NAME, [])
    out = []
    for m in raw if isinstance(raw, list) else []:
        if isinstance(m, dict) and isinstance(m.get("t_ms"), (int, float)) and m["t_ms"] >= 0:
            out.append({"id": str(m.get("id") or ""), "t_ms": int(m["t_ms"]), "label": str(m.get("label") or ""),
                        "created": str(m.get("created") or "")})
    out.sort(key=lambda m: m["t_ms"])
    return out


def add(mid: str, t_ms, label: str = "") -> tuple[dict, list[dict], bool]:
    """记一个打点。返回 (这个打点, 全部打点, 是不是新增的)。离已有打点太近时返回已有的那个。"""
    if isinstance(t_ms, bool):
        raise ValueError("t_ms 要是毫秒数")
    try:
        t = int(t_ms)
    except (TypeError, ValueError, OverflowError) as e:
        raise ValueError("t_ms 要是毫秒数") from e
    if t < 0:
        raise ValueError("时间不能是负数")
    with store.locked():
        marks = load(mid)
        for m in marks:
            if abs(m["t_ms"] - t) < DEDUP_MS:
                return m, marks, False
        if len(marks) >= MAX_MARKS:
            raise ValueError(f"一场最多 {MAX_MARKS} 个打点")
        mark = {"id": secrets.token_hex(3), "t_ms": t, "label": (label or "").strip()[:60],
                "created": datetime.now().isoformat(timespec="seconds")}
        marks.append(mark)
        marks.sort(key=lambda m: m["t_ms"])
        store.save(mid, NAME, marks)
        return mark, marks, True


def remove(mid: str, mark_id: str) -> list[dict]:
    with store.locked():
        marks = load(mid)
        left = [m for m in marks if m["id"] != mark_id]
        if len(left) == len(marks):
            raise KeyError(mark_id)
        store.save(mid, NAME, left)
        return left


def near(marks: list[dict], start_ms, end_ms=None, window_ms: int = WINDOW_MS) -> list[dict]:
    """落在 [start-window, end+window] 里的打点。"""
    if start_ms is None:
        return []
    end_ms = start_ms if end_ms is None else end_ms
    return [m for m in marks if start_ms - window_ms <= m["t_ms"] <= end_ms + window_ms]


def window_paras(paras: list[dict], t_ms: int, window_ms: int = WINDOW_MS) -> list[dict]:
    return [p for p in paras if p["end"] >= t_ms - window_ms and p["start"] <= t_ms + window_ms]


def snippet(paras: list[dict], t_ms: int, n: int = 40) -> str:
    """打点所在（或最近）一段转写的开头，给列表显示用。"""
    if not paras:
        return ""
    hit = next((p for p in paras if p["start"] <= t_ms <= p["end"]), None)
    hit = hit or min(paras, key=lambda p: min(abs(p["start"] - t_ms), abs(p["end"] - t_ms)))
    return (hit.get("text") or "").strip()[:n]


def prompt_block(meta: dict, marks: list[dict], paras: list[dict], spk_name,
                 max_total_chars: int | None = None) -> str:
    """交给模型的“重点打点”说明。没有打点或没有转写，返回空串。"""
    if not marks or not paras:
        return ""
    limit = _TOTAL_CHARS if max_total_chars is None else min(_TOTAL_CHARS, max(1, int(max_total_chars)))
    parts, total = [], 0
    for i, m in enumerate(marks, 1):
        lines = [f"[{fmt_ts(p['start'])}] {spk_name(meta, p['spk'])}：{p['text']}" for p in window_paras(paras, m["t_ms"])]
        text = "\n".join(lines)[:_BLOCK_CHARS]
        if not text.strip():
            continue
        block = f"【打点 {i} · {fmt_ts(m['t_ms'])}】" + (f"（备注：{m['label']}）" if m.get("label") else "") + "\n" + text
        if total + len(block) > limit:
            break
        parts.append(block)
        total += len(block)
    if not parts:
        return ""
    return ("参会者在录音时按了重点打点（下面是每个打点前后约 30 秒的转写）。这些地方是他认为重要的，纪要要优先覆盖："
            "每个打点附近只要有实质内容，就在 highlights 里至少给一条要点，并在相关小节里写清楚；"
            "如果那一段只是闲聊或没有内容，就不用硬写。\n\n" + "\n\n".join(parts))
