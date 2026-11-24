"""列出周会还没完成（或输出无效）的裁判任务和提取任务，输出 JSON，作为分段 workflow 的 args.items。

  python3 tests/eval/weekly_todo.py [--max 30]
"""
import json
import re
import sys
from pathlib import Path

D = Path.home() / "eval-out/claims/weekly"
mx = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 10**9
items = []
for b in sorted((D / "batches").glob("b*.md")):
    ids = re.findall(r"^## 陈述 (\S+)", b.read_text(), re.M)
    for j in ("gpt", "claude"):
        try:
            ok = [x["id"] for x in json.loads((D / "judge" / j / f"{b.stem}.json").read_text())] == ids
        except Exception:
            ok = False
        if not ok:
            items.append({"kind": "judge", "b": b.stem, "j": j})
for c in sorted((D / "chunks").glob("c*.md")):
    for j in ("gpt", "claude"):
        try:
            d = json.loads((D / "extract" / j / f"{c.stem}.json").read_text())
            ok = isinstance(d, list) and all(x.get("kind") in ("决定", "待办") for x in d)
        except Exception:
            ok = False
        if not ok:
            items.append({"kind": "extract", "b": c.stem, "j": j})
print(json.dumps({"total": len(items), "items": items[:mx]}, ensure_ascii=False))
