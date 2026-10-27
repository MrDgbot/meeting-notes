"""第 3 项第二轮的公共部分：读第一轮的 20 处重叠片段、参考/系统的说话人时间段、按多路输出打分。

打分和第一轮 sep_probe_b.py 一致：两句参考 A、B 分给输出的两路，取最好的分法；
输出多于两路时，多出来的路全部算插入；只有一路时按“A+B 或 B+A 拼起来对这一路”算（和只识别混合音相同）。
"""
import json, re, sys, unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "audio"))
import cer  # noqa: E402

D = Path.home() / "eval-data/ali-eval"  # 只用开发集
PROBE = Path.home() / "eval-out/sep-probe"
OUT = Path.home() / "eval-out/overlap2"
OUT.mkdir(parents=True, exist_ok=True)
norm = lambda s: re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).upper())
E = lambda r, h: sum(cer.edit_ops(r, h))


def stm(p: Path) -> list[tuple]:
    r = []
    for ln in p.read_text().splitlines():
        f = ln.split(maxsplit=5)
        if len(f) == 6:
            r.append((f[2], float(f[3]), float(f[4]), f[5]))
    return r


def rttm(p: Path) -> list[tuple]:
    r = []
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            r.append((f[7], float(f[3]), float(f[3]) + float(f[4])))
    return r


def meta() -> list[dict]:
    """第一轮的 20 处片段，补上两句参考各自的说话人和起止（按文字在参考 stm 里找回）。"""
    ms = json.loads((PROBE / "meta.json").read_text())
    for m in ms:
        rows = stm(D / "ref" / f"{m['session']}.stm")
        for key in ("A", "B"):
            hit = [r for r in rows if r[3] == m["ref" + key] and r[1] >= m["lo"] - 0.01 and r[2] <= m["hi"] + 0.01]
            assert len(hit) == 1, (m["k"], key, hit)
            m["spk" + key], m["st" + key], m["en" + key] = hit[0][0], hit[0][1], hit[0][2]
    return ms


def score(m: dict, hyps: list[str]) -> int:
    """hyps：这一处片段输出的若干路文字（已 norm）。返回编辑距离（两句参考分给各路，取最好的分法）。"""
    A, B = norm(m["refA"]), norm(m["refB"])
    hyps = [h for h in hyps if h] or [""]
    tot = sum(len(h) for h in hyps)
    # 两句都落在同一路，其余各路全算插入
    best = min(min(E(A + B, h), E(B + A, h)) + tot - len(h) for h in hyps)
    for i, hi in enumerate(hyps):
        for j, hj in enumerate(hyps):
            if i != j:
                best = min(best, E(A, hi) + E(B, hj) + tot - len(hi) - len(hj))
    return best


def nref(m: dict) -> int:
    return len(norm(m["refA"])) + len(norm(m["refB"]))
