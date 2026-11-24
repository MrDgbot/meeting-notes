"""合并漏写核对（docs/prereg-claims.md 第 6 节）。写在看到任何核对结果之前。

  python3 tests/eval/merge_omission.py

- “会上确实有的事”：两个裁判给出了同一对 (A, B)，并且都判“有依据”。
- 漏写（主口径）：两个裁判都判这份纪要“没写到”；后果取两人都判“严重”的为严重。
- 上界：任一裁判判“没写到”就算漏写，任一裁判判“严重”就算严重。
- “部分写到”单列，不算漏写。
- 已知局限：同一件事可能在相邻两段里各被提取一次，这里不去重，条数可能略多。
"""
import json
from collections import Counter
from pathlib import Path

H = Path.home()
D = H / "eval-out/claims/weekly"
KEY = json.loads((H / "eval-data/claims-keys/coverage_key.json").read_text())
HOURS = 5684.98 / 3600
J = ("gpt", "claude")
rows = []
for c, k in KEY.items():
    got = {j: {(x["a"], x["b"]): x for x in json.loads((D / "coverage" / j / f"{c}.json").read_text())} for j in J}
    for pair in sorted(set(got["gpt"]) & set(got["claude"])):
        g, h = got["gpt"][pair], got["claude"][pair]
        if not (g["real"] == h["real"] == "有依据"):
            continue
        r = {"chunk": c, "pair": list(pair), "what": h["what"], "sev": [g["severity"], h["severity"]], "windows": sorted(set(g.get("windows") or []) | set(h.get("windows") or []))}
        for lab in ("X", "Y"):
            m = k[lab]
            r[m] = [g[lab], h[lab]]
            r[m + "_quote"] = [g.get(lab + "_quote"), h.get(lab + "_quote")]
        rows.append(r)
summary = {"会上确实有的事（两人配上且都判有依据）": len(rows),
           "按段": dict(Counter(r["chunk"] for r in rows)),
           "两人配对数（不论真假）": {c: [len(json.loads((D / "coverage" / j / f"{c}.json").read_text())) for j in J] for c in KEY}}
for m in ("M1", "M2"):
    miss = [r for r in rows if r[m] == ["没写到", "没写到"]]
    miss_up = [r for r in rows if "没写到" in r[m]]
    summary[m] = {
        "漏写（两人都判没写到）": len(miss),
        "其中严重（两人都判严重）": sum(r["sev"] == ["严重", "严重"] for r in miss),
        "漏写上界（任一人判没写到）": len(miss_up),
        "上界里的严重（任一人判严重）": sum("严重" in r["sev"] for r in miss_up),
        "严重漏写每小时（主口径）": round(sum(r["sev"] == ["严重", "严重"] for r in miss) / HOURS, 1),
        "部分写到（两人都判）": sum(r[m] == ["部分写到", "部分写到"] for r in rows),
        "两人判断分布（gpt/claude）": dict(Counter("/".join(r[m]) for r in rows).most_common()),
    }
(D / "omission.json").write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1, default=list))
print(json.dumps(summary, ensure_ascii=False, indent=1, default=list))
