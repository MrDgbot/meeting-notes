"""漏写核对的输入（docs/prereg-claims.md 第 6 节）。写在看到两位标注员的提取结果之前。

  python3 tests/eval/build_coverage.py

每段 cNN 写 ~/eval-out/claims/weekly/coverage_in/cNN.md：甲 = gpt 的提取，乙 = claude 的提取，加两份纪要。
纪要用中性的 X/Y 标签，每段按种子 20261026 随机决定哪份是 X；对应关系写进 ~/eval-data/claims-keys/coverage_key.json，裁判看不到。
"""
import json
import random
from pathlib import Path

H = Path.home()
D = H / "eval-out/claims/weekly"
MIN = {"M1": (H / "eval-out/minutes/助手整理.md").read_text(), "M2": (H / "eval-out/minutes/飞书妙记.md").read_text()}
rng = random.Random(20261026)
(D / "coverage_in").mkdir(exist_ok=True)
key = {}
fmt = lambda p, i, x: (f"- {p}{i}［{x.get('kind')}］{x.get('what')}｜谁：{x.get('who')}｜何时：{x.get('when')}｜窗口：{','.join(x.get('windows') or [])}"
                       f"｜原话：{x.get('quote')}")
for c in sorted((D / "chunks").glob("c*.md")):
    A = json.loads((D / "extract/gpt" / f"{c.stem}.json").read_text())
    B = json.loads((D / "extract/claude" / f"{c.stem}.json").read_text())
    x_is = "M1" if rng.random() < 0.5 else "M2"
    y_is = "M2" if x_is == "M1" else "M1"
    key[c.stem] = {"X": x_is, "Y": y_is, "nA": len(A), "nB": len(B)}
    txt = (f"# 段 {c.stem}\n\n## 甲的清单（{len(A)} 条）\n" + ("\n".join(fmt("A", i, x) for i, x in enumerate(A)) or "（无）")
           + f"\n\n## 乙的清单（{len(B)} 条）\n" + ("\n".join(fmt("B", i, x) for i, x in enumerate(B)) or "（无）")
           + f"\n\n## 纪要X\n\n{MIN[x_is]}\n\n## 纪要Y\n\n{MIN[y_is]}\n")
    (D / "coverage_in" / f"{c.stem}.md").write_text(txt)
(H / "eval-data/claims-keys/coverage_key.json").write_text(json.dumps(key, ensure_ascii=False, indent=1))
print({k: (v["nA"], v["nB"]) for k, v in key.items()})
