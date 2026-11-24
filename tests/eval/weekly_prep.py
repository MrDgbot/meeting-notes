"""从一场真实会议里抽出要人工校对的片段，准备校对页要用的文件。

  .venv/bin/python tests/eval/weekly_prep.py ~/eval-data/weekly-1023

抽样（固定随机种子，可复现）：候选窗口从某个段落开头起、到某个段落结尾止，长 110–140 秒（边界落在停顿处，
不会把一句话切成两半）。按“说话人来回切换多少”和“业务词多少”分层，各抽一段，再加一段别人主讲、一段纯随机：
  A 一人长讲·业务词少  B 一人长讲·业务词多  C 多人来回·业务词少  D 多人来回·业务词多  E 不是 0 号主讲  F 随机
预填文字用 Paraformer（不是产品现在用的豆包，也不是 Nano），减少校对时被被评测的引擎带偏；Paraformer 因此不参加比较。
每个说话人编号再剪 3 段样本，用来让参会的人认出是谁。
"""
import json
import random
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

D = Path(sys.argv[1]).expanduser()
SEED = 20261025
ps = json.loads((D / "transcript.json").read_text())["paragraphs"]
TERMS = re.compile(r"[A-Za-z]{2,}|长尾词|子ASIN|家族|竞品|促销|广告|关键词|链接|变体|ERP|库存|折扣|定价|上架|新品", re.I)


def windows():
    out = []
    for i in range(len(ps)):
        j = i
        while j < len(ps) and ps[j]["end"] - ps[i]["start"] < 110000:
            j += 1
        if j >= len(ps) or ps[j]["end"] - ps[i]["start"] > 140000:
            continue
        seg = ps[i:j + 1]
        dur = {}
        for p in seg:
            dur[p["spk"]] = dur.get(p["spk"], 0) + p["end"] - p["start"]
        out.append(dict(a=seg[0]["start"], b=seg[-1]["end"],
                        changes=sum(1 for x, y in zip(seg, seg[1:]) if x["spk"] != y["spk"]),
                        terms=len(TERMS.findall("".join(p["text"] for p in seg))), main=max(dur, key=dur.get)))
    return out


W = windows()
rng = random.Random(SEED)
strata = [("A", "一人长讲·业务词少", lambda w: w["changes"] <= 2 and w["terms"] <= 3),
          ("B", "一人长讲·业务词多", lambda w: w["changes"] <= 2 and w["terms"] >= 6),
          ("C", "多人来回·业务词少", lambda w: w["changes"] >= 9 and w["terms"] <= 3),
          ("D", "多人来回·业务词多", lambda w: w["changes"] >= 9 and w["terms"] >= 6),
          ("E", "不是 0 号主讲", lambda w: w["main"] != 0),
          ("F", "随机", lambda w: True)]
picked = []
for code, label, ok in strata:
    pool = [w for w in W if ok(w) and all(w["b"] <= p["a"] or w["a"] >= p["b"] for p in picked)]
    if not pool:
        print("这一层没有候选：", code, label)
        continue
    w = rng.choice(pool)
    picked.append({**w, "code": code, "label": label, "pool": len(pool)})
picked.sort(key=lambda w: w["a"])

wav = D / "audio16k.wav"
if not wav.exists():
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(D / "audio.mp3"), "-ac", "1", "-ar", "16000", str(wav)], check=True)
x, sr = sf.read(str(wav), dtype="float32")
(D / "clips").mkdir(exist_ok=True)
(D / "samples").mkdir(exist_ok=True)

from funasr import AutoModel  # noqa: E402

m = AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc", disable_update=True, disable_pbar=True,
              disable_log=True, device="mps")
clips = []
for k, w in enumerate(picked, 1):
    a, b = w["a"], w["b"]
    seg = x[int(a * sr / 1000):int(b * sr / 1000)]
    f = D / "clips" / f"c{k}.wav"
    sf.write(str(f), seg, sr, subtype="PCM_16")
    r = m.generate(input=str(f), sentence_timestamp=True)[0]
    rows = [{"start": s["start"], "end": s["end"], "text": s["text"], "spk": ""} for s in (r.get("sentence_info") or [])]
    if not rows and r.get("text"):
        rows = [{"start": 0, "end": b - a, "text": r["text"], "spk": ""}]
    clips.append({"id": f"c{k}", "file": f"clips/c{k}.wav", "start": a, "end": b, "code": w["code"], "label": w["label"],
                  "changes": w["changes"], "terms": w["terms"], "pool": w["pool"], "prefill": rows})
    print(f"c{k} {w['code']} {w['label']}：{a / 60000:.1f}–{b / 60000:.1f} 分钟，切换 {w['changes']} 次，业务词 {w['terms']}，"
          f"候选 {w['pool']}，预填 {len(rows)} 句", flush=True)

samples = {}
for spk in sorted({p["spk"] for p in ps}):
    mine = [p for p in ps if p["spk"] == spk]
    good = sorted([p for p in mine if 3000 <= p["end"] - p["start"] <= 12000], key=lambda p: -(p["end"] - p["start"]))
    good += [p for p in sorted(mine, key=lambda p: -(p["end"] - p["start"])) if p not in good and p["end"] - p["start"] >= 1500]
    pick = sorted(good[:6], key=lambda p: p["start"])
    pick = [pick[i] for i in np.linspace(0, len(pick) - 1, min(3, len(pick))).round().astype(int)] if pick else []
    samples[spk] = []
    for n, p in enumerate(pick):
        a, b = p["start"], min(p["end"], p["start"] + 12000)
        f = D / "samples" / f"spk{spk}_{n}.wav"
        sf.write(str(f), x[int(a * sr / 1000):int(b * sr / 1000)], sr, subtype="PCM_16")
        samples[spk].append({"file": f"samples/{f.name}", "start": a, "text": p["text"][:60]})
    tot = sum(p["end"] - p["start"] for p in mine) / 1000
    print(f"说话人 {spk}：{len(mine)} 段，共 {tot:.0f} 秒，样本 {len(samples[spk])} 段", flush=True)

(D / "manifest.json").write_text(json.dumps({"seed": SEED, "windows_total": len(W), "clips": clips, "samples": samples},
                                            ensure_ascii=False, indent=1))
