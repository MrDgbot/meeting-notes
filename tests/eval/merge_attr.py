"""合并两个裁判的错误归因，按第 9 节规则给出方向（docs/prereg-claims.md 第 5、9 节）。写在看到任何归因结果之前。

  python3 tests/eval/merge_attr.py

- 每条：两人归因相同就取该环节，不同记“归因分歧”。
- 两人都填“复核：有依据”的，视为上一步判错，主口径里不算错误，单独报条数。只有一人填的，照常算。
- 第 9 节：只看 M1；严重错误（merged.json 里两人都判严重且一致判错）按环节计数，再加上两人都判“没写到”且都判严重的漏写（omission.json），作为“漏写”环节。
  第一、二名相差 ≤ 2 时按改动范围取小的：大模型 = 漏写 < 识别 < 说话人 < 检测（漏写的改法和大模型一样，都是改提示或改生成，所以视为同级）。
  归因分歧、判不了不参与排名，单独报。M1 严重错误总数 ≤ 2 → 结论是“可以当真用”。
输出 ~/eval-out/claims/weekly/attr_merged.json（审计页会读它）和 decision.json。
"""
import json
from collections import Counter
from pathlib import Path

H = Path.home()
D = H / "eval-out/claims/weekly"
M = {r["id"]: r for r in json.loads((D / "merged.json").read_text())["rows"]}
OM = json.loads((D / "omission.json").read_text())["rows"] if (D / "omission.json").exists() else None
A = {}
for j in ("gpt", "claude"):
    for f in sorted((D / "attr" / j).glob("a*.json")):
        for x in json.loads(f.read_text()):
            A.setdefault(x["id"], {})[j] = x
bad = [r for r in M.values() if r["merged"] in {"与原话矛盾", "找不到依据", "张冠李戴"}]
missing = [r["id"] for r in bad if len(A.get(r["id"], {})) < 2]
out = {}
for r in bad:
    if r["id"] in missing:
        continue
    g, c = A[r["id"]]["gpt"]["stage"], A[r["id"]]["claude"]["stage"]
    out[r["id"]] = {"stage": g if g == c else "归因分歧", "stages": [g, c], "src": r["src"], "severe": r["sev_strict"],
                    "overturned": g == c == "复核：有依据"}
(D / "attr_merged.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
RANK = {"大模型": 0, "漏写": 0, "识别": 1, "说话人": 2, "检测": 3}
dec = {"缺归因": missing}
for m in ("M1", "M2"):
    sev = [v for v in out.values() if v["src"] == m and v["severe"] and not v["overturned"]]
    cnt = Counter(v["stage"] for v in sev)
    if OM is not None:
        cnt["漏写"] = sum(r[m] == ["没写到", "没写到"] and r["sev"] == ["严重", "严重"] for r in OM)
    ranked = sorted(((k, n) for k, n in cnt.items() if k in RANK), key=lambda kv: (-kv[1], RANK[kv[0]]))
    total = sum(n for k, n in cnt.items() if k in RANK)
    pick = None
    if ranked:
        close = [k for k, n in ranked if ranked[0][1] - n <= 2]  # 与第一名相差不超过 2 的都算并列
        pick = min(close, key=lambda k: RANK[k])
    dec[m] = {"严重错误按环节（含漏写）": dict(cnt), "参与排名的严重总数": total,
              "两人都复核为有依据（不计）": sum(v["overturned"] for v in out.values() if v["src"] == m),
              "所有一致判错的归因分布": dict(Counter(v["stage"] for v in out.values() if v["src"] == m)),
              "方向": ("可以当真用（严重 ≤ 2）" if total <= 2 else pick) if m == "M1" else "（M2 只作对照）"}
(D / "decision.json").write_text(json.dumps(dec, ensure_ascii=False, indent=1))
print(json.dumps(dec, ensure_ascii=False, indent=1))
