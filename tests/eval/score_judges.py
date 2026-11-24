"""裁判自证打分（docs/prereg-claims.md 第 8 节）。写在看到裁判结果之前。

  python3 tests/eval/score_judges.py ~/eval-out/claims/ali ~/eval-data/claims-keys/ali_key.json

- 合并：两个裁判结论相同取该结论；不同记“裁判分歧”。
- 检出：判为 与原话矛盾 / 找不到依据 / 张冠李戴。“判不了”和“裁判分歧”都算没检出（偏保守）。
- 误报：真陈述被判为 与原话矛盾 / 找不到依据 / 张冠李戴；“裁判分歧”时按两种口径各报一次（按较差的那个裁判算 = 上界）。
- κ：两个裁判在五类结论上的 Cohen's κ（主），以及“错 vs 不错”二分类的 κ（辅）。
- 严重类注入错误 = 改数字、反转、编造待办；换对象单独报。
"""
import json
import math
import sys
from collections import Counter
from pathlib import Path

D, K = Path(sys.argv[1]).expanduser(), json.loads(Path(sys.argv[2]).expanduser().read_text())
BAD = {"与原话矛盾", "找不到依据", "张冠李戴"}
J = {}
for jd in sorted((D / "judge").iterdir()):
    for f in sorted(jd.glob("b*.json")):
        for x in json.loads(f.read_text()):
            J.setdefault(x["id"], {})[jd.name] = x
names = sorted({n for v in J.values() for n in v})
assert len(names) == 2, names
missing = [k for k in K if k not in J or len(J[k]) < 2]


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"),) * 3
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return p, (c - r) / d, (c + r) / d


def kappa(pairs):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return (po - pe) / (1 - pe) if pe < 1 else float("nan")


rows = []
for cid, k in K.items():
    if cid in missing:
        continue
    a, b = (J[cid][n]["verdict"] for n in names)
    merged = a if a == b else "裁判分歧"
    rows.append({"id": cid, "truth": k["truth"], "a": a, "b": b, "merged": merged})
out = {"judges": names, "n": len(rows), "missing": missing}
for label, sel in (("严重类注入（数字+反转+编造）", {"number", "negate", "fab"}), ("改数字", {"number"}), ("反转", {"negate"}),
                   ("编造待办", {"fab"}), ("换对象（一般）", {"entity"})):
    rs = [r for r in rows if r["truth"] in sel]
    k = sum(r["merged"] in BAD for r in rs)
    p, lo, hi = wilson(k, len(rs))
    out[f"检出率 {label}"] = f"{k}/{len(rs)} = {p:.1%}（95% 区间 {lo:.1%}–{hi:.1%}）"
    for n_, key in zip(names, "ab"):
        out[f"  其中 {n_} 单独"] = None
        out[f"检出率 {label}｜{n_} 单独"] = f"{sum(r[key] in BAD for r in rs)}/{len(rs)}"
    del out[f"  其中 {n_} 单独"]
tr = [r for r in rows if r["truth"] == "true"]
fa_merged = sum(r["merged"] in BAD for r in tr)
fa_upper = sum(r["a"] in BAD or r["b"] in BAD for r in tr)
p, lo, hi = wilson(fa_merged, len(tr))
out["误报（真陈述被判错）合并结论"] = f"{fa_merged}/{len(tr)} = {p:.1%}（95% 区间 {lo:.1%}–{hi:.1%}）"
out["误报 上界（任一裁判判错就算）"] = f"{fa_upper}/{len(tr)} = {fa_upper / len(tr):.1%}"
ab = sum(r["merged"] in ("判不了", "裁判分歧") for r in rows)
out["判不了 + 裁判分歧"] = f"{ab}/{len(rows)} = {ab / len(rows):.1%}"
out["κ 五类"] = round(kappa([(r["a"], r["b"]) for r in rows]), 3)
out["κ 二分类（错 vs 不错）"] = round(kappa([(r["a"] in BAD, r["b"] in BAD) for r in rows]), 3)
sev = {"number", "negate", "fab"}
det = [r for r in rows if r["truth"] in sev]
gates = {
    "检出率 ≥ 85%": sum(r["merged"] in BAD for r in det) / max(1, len(det)) >= 0.85,
    "误报 ≤ 10%": fa_merged / max(1, len(tr)) <= 0.10,
    "判不了 ≤ 20%": ab / len(rows) <= 0.20,
    "κ ≥ 0.6": out["κ 五类"] >= 0.6,
}
# D3：第二个裁判换成了 Claude（它也写了校准陈述），所以每个裁判单独也要过检出率和误报两道门槛
for n_, key in zip(names, "ab"):
    gates[f"{n_} 单独：检出率 ≥ 85%"] = sum(r[key] in BAD for r in det) / max(1, len(det)) >= 0.85
    gates[f"{n_} 单独：误报 ≤ 10%"] = sum(r[key] in BAD for r in tr) / max(1, len(tr)) <= 0.10
    out[f"{n_} 单独：严重类检出 / 误报 / 判不了"] = (f"{sum(r[key] in BAD for r in det)}/{len(det)}，{sum(r[key] in BAD for r in tr)}/{len(tr)}，"
                                          f"{sum(r[key] == '判不了' for r in rows)}/{len(rows)}")
out["门槛"] = gates
out["全部通过"] = all(gates.values())
out["混淆表（真相 → 合并结论）"] = {t: dict(Counter(r["merged"] for r in rows if r["truth"] == t)) for t in sorted({r["truth"] for r in rows})}
(D / "calibration.json").write_text(json.dumps({"summary": out, "rows": rows}, ensure_ascii=False, indent=1))
print(json.dumps(out, ensure_ascii=False, indent=1))
