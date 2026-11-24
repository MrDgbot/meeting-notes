"""把造好、核对过的 AliMeeting 陈述按预注册的种子组装成裁判用的测试集（docs/prereg-claims.md 第 8 节）。

  python3 tests/eval/assemble_ali.py ~/eval-out/claims/ali

读 <目录>/<场>_gen.json、<场>_verify.json；写 claims.json（给裁判，无答案）和 key.json（答案，裁判看不到）。
- 真陈述没被核对通过的，整条丢掉；错误版本没被核对确认“确实错”的，不参与抽取。
- 每条：随机数 < 0.5 用真陈述；否则在可用的错误类型里等概率抽一种。种子 20261026。
"""
import json
import random
import sys
from pathlib import Path

D = Path(sys.argv[1]).expanduser()
SEED = 20261026
KEYS = {"number": "mut_number", "negate": "mut_negate", "entity": "mut_entity", "fab": "fab_todo"}
items, key, dropped = [], {}, 0
for g in sorted(D.glob("*_gen.json")):
    ses = g.name[:-len("_gen.json")]
    gen = json.loads(g.read_text())
    ver = {v["i"]: v for v in json.loads((D / f"{ses}_verify.json").read_text())}
    for i, c in enumerate(gen):
        v = ver.get(i, {})
        if not v.get("claim_ok"):
            dropped += 1
            continue
        rng = random.Random(f"{SEED}-{ses}-{i}")
        avail = [t for t, k in KEYS.items() if c.get(k) and v.get(f"{t}_bad")]
        if rng.random() < 0.5 or not avail:
            text, truth = c["claim"], "true"
        else:
            truth = rng.choice(avail)
            text = c[KEYS[truth]]
        cid = f"A{len(items) + 1:03d}"
        items.append({"id": cid, "session": ses, "text": text, "time_hint": None})
        key[cid] = {"truth": truth, "type": c.get("type"), "cite": c.get("cite"), "true_claim": c["claim"]}
random.Random(SEED).shuffle(items)
for n, it in enumerate(items):  # 打乱后重新编号，编号不泄露来源顺序
    old = it["id"]
    it["id"] = f"A{n + 1:03d}"
    key[it["id"] + "_"] = key.pop(old)
key = {k[:-1]: v for k, v in key.items()}
(D / "claims.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))
(D / "key.json").write_text(json.dumps(key, ensure_ascii=False, indent=1))
from collections import Counter
print(f"{len(items)} 条（丢掉 {dropped} 条没核对通过的真陈述）；答案分布 {Counter(v['truth'] for v in key.values())}")
