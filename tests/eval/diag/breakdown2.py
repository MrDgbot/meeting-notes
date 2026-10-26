"""和 score.py 一样做整场 FIFO 对齐，再把每个参考字的错误归到它所在片段的重叠分组（多字归到前一个参考字）。"""
import json, re, sys, unicodedata
from collections import defaultdict
from pathlib import Path
import jiwer
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_stm, ovl_frac, norm  # noqa

REF = Path.home() / "eval-data/ali-test/ref"
HYP = Path(sys.argv[1]).expanduser()

def grp_of(f):
    return "单人(0%)" if f == 0 else ("部分重叠(<50%)" if f < 0.5 else "重叠为主(≥50%)")

agg = defaultdict(lambda: defaultdict(float))
for hp in sorted(HYP.glob("*.json")):
    d = json.loads(hp.read_text())
    ref = sorted(read_stm(REF / f"{hp.stem}.stm"), key=lambda r: r[1])
    nspk = len({r[0] for r in ref})
    rtxt, rgrp = [], []
    for seg in ref:
        g = grp_of(ovl_frac(seg, ref)); rtxt.append(seg[3]); rgrp += [g] * len(seg[3])
    R = "".join(rtxt)
    H = "".join(norm(s["text"]) for s in sorted(d["sents"], key=lambda s: s["start"]))
    o = jiwer.process_characters(R, H)
    cnt = defaultdict(lambda: defaultdict(int))
    for g in rgrp: cnt[g]["n"] += 1
    for ch in o.alignments[0]:
        if ch.type == "equal": continue
        if ch.type in ("substitute", "delete"):
            for i in range(ch.ref_start_idx, ch.ref_end_idx):
                cnt[rgrp[i]]["sub" if ch.type == "substitute" else "del"] += 1
            if ch.type == "substitute" and (ch.hyp_end_idx - ch.hyp_start_idx) != (ch.ref_end_idx - ch.ref_start_idx):
                pass
        elif ch.type == "insert":
            g = rgrp[max(ch.ref_start_idx - 1, 0)]
            cnt[g]["ins"] += ch.hyp_end_idx - ch.hyp_start_idx
    for g, c in cnt.items():
        for key in (g, f"{nspk}人|{g}", "合计", f"{nspk}人|合计"):
            for k, v in c.items(): agg[key][k] += v
tot = agg["合计"]["n"]
print(f"{'组':<20}{'参考字占比':>8}{'字错率':>8}{'漏':>7}{'替换':>7}{'多':>7}   占全部错字")
allerr = sum(agg["合计"][k] for k in ("sub", "del", "ins"))
for k in sorted(agg, key=lambda k: ("|" in k, k.split("|")[0], "合计" in k, k)):
    v = agg[k]; n = v["n"]; e = v["sub"] + v["del"] + v["ins"]
    print(f"{k:<20}{n / tot:>9.1%}{e / n:>9.1%}{v['del'] / n:>8.1%}{v['sub'] / n:>8.1%}{v['ins'] / n:>8.1%}{e / allerr:>10.1%}")
