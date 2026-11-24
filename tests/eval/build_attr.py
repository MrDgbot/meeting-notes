"""给“一致判错”的陈述做归因批次（docs/prereg-claims.md 第 5 节）。

  .venv/bin/python tests/eval/build_attr.py   （仓库的 .venv）

读 merged.json、evidence_index.json、windows_weekly.json；写 ~/eval-out/claims/weekly/attr_batches/a<NN>.md。
依据列：M1 → 产品当时，M2 → 飞书。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_evidence as be  # noqa: E402

H = Path.home()
D = H / "eval-out/claims/weekly"
M = json.loads((D / "merged.json").read_text())["rows"]
EV = json.loads((D / "evidence_index.json").read_text())
W = json.loads((D / "windows_weekly.json").read_text())
cols = ["飞书", "产品当时", "豆包重跑", "Nano", "Paraformer", "SenseVoice"]
BASIS = {"M1": "产品当时", "M2": "飞书"}
bad = [r for r in M if r["merged"] in {"与原话矛盾", "找不到依据", "张冠李戴"}]
(D / "attr_batches").mkdir(exist_ok=True)
for b in range(0, len(bad), 8):
    parts = []
    for r in bad[b:b + 8]:
        ws = [{**W[i], "cols": {k: [tuple(x) for x in v] for k, v in W[i]["cols"].items()}} for i in EV[r["id"]]]
        parts.append(f"## 陈述 {r['id']}\n{r['text']}\n（上一步的一致结论：{r['merged']}；依据列：{BASIS[r['src']]}；纪要给出的时间点：{r.get('time_hint') or '无'}）\n\n### 证据窗口\n"
                     + "\n\n".join(be.render(w, cols) for w in ws))
    (D / "attr_batches" / f"a{b // 8:02d}.md").write_text("\n\n---\n\n".join(parts) + "\n")
print(len(bad), "条，", (len(bad) + 7) // 8, "批")
