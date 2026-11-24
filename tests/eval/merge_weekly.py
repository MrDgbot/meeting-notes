"""合并周会两个裁判的判定（docs/prereg-claims.md 第 4、7 节）。写在看到周会判定结果之前。

  python3 tests/eval/merge_weekly.py

结论合并：两个裁判相同取该结论，不同记“裁判分歧”。
后果合并（预注册没写死，这里在看结果前定下）：
  - 主口径：两个裁判都判“严重”才算严重；
  - 上界：任一裁判判“严重”就算严重，并且把“裁判分歧”里任一裁判判错的也算错。
“张冠李戴”在 AliMeeting 上没校准（偏离 D1），单列。名称类“与原话矛盾”是裁判的已知盲区（同音字），单列，待复听。
输出 ~/eval-out/claims/weekly/merged.json 和摘要。
"""
import json
import math
from collections import Counter
from pathlib import Path

H = Path.home()
D = H / "eval-out/claims/weekly"
K = json.loads((H / "eval-data/claims-keys/weekly_key.json").read_text())
C = {c["id"]: c for c in json.loads((D / "claims.json").read_text())}
BAD = {"与原话矛盾", "找不到依据", "张冠李戴"}
HOURS = 5684.98 / 3600
J = {}
for jd in sorted((D / "judge").iterdir()):
    for f in sorted(jd.glob("b*.json")):
        for x in json.loads(f.read_text()):
            J.setdefault(x["id"], {})[jd.name] = x
names = sorted({n for v in J.values() for n in v})
missing = [k for k in C if len(J.get(k, {})) < 2]


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return p, (c - r) / d, (c + r) / d


rows = []
for cid, c in C.items():
    if cid in missing:
        continue
    a, b = (J[cid][n] for n in names)
    merged = a["verdict"] if a["verdict"] == b["verdict"] else "裁判分歧"
    rows.append({"id": cid, "src": K[cid]["src"], "type": K[cid]["type"], "text": c["text"], "time_hint": c.get("time_hint"),
                 "merged": merged, "va": a["verdict"], "vb": b["verdict"], "sa": a["severity"], "sb": b["severity"],
                 "sev_strict": a["severity"] == b["severity"] == "严重", "sev_loose": "严重" in (a["severity"], b["severity"]),
                 "quote": {names[0]: a.get("quote"), names[1]: b.get("quote")}, "reason": {names[0]: a.get("reason"), names[1]: b.get("reason")},
                 "windows": sorted(set(a.get("windows") or []) | set(b.get("windows") or []))})
summary = {"judges": names, "missing": missing, "hours": round(HOURS, 3)}
for m in ("M1", "M2"):
    rs = [r for r in rows if r["src"] == m]
    n = len(rs)
    sev_main = [r for r in rs if r["merged"] in BAD and r["sev_strict"]]
    sev_upper = [r for r in rs if (r["merged"] in BAD or (r["merged"] == "裁判分歧" and (r["va"] in BAD or r["vb"] in BAD))) and r["sev_loose"]]
    p, lo, hi = wilson(len(sev_main), n)
    summary[m] = {
        "陈述数": n,
        "结论分布": dict(Counter(r["merged"] for r in rs)),
        "错（一致判错）": sum(r["merged"] in BAD for r in rs),
        "严重且一致判错（主指标）": f"{len(sev_main)} 条，占 {p:.1%}（95% 区间 {lo:.1%}–{hi:.1%}），每小时 {len(sev_main) / HOURS:.1f} 条",
        "严重错误上界": f"{len(sev_upper)} 条，每小时 {len(sev_upper) / HOURS:.1f} 条",
        "其中张冠李戴（未校准）": sum(r["merged"] == "张冠李戴" for r in sev_main),
        "其中名称类矛盾（待复听）": sum(r["merged"] == "与原话矛盾" and r["type"] == "名称" for r in rs),
        "按类型的一致判错数": dict(Counter(r["type"] for r in rs if r["merged"] in BAD)),
    }
(D / "merged.json").write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1))
print(json.dumps(summary, ensure_ascii=False, indent=1))
