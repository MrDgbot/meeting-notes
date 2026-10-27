"""第 3 项第二轮 · 方法 C 打分：把 round2_tse_extract.py 提出的两路交给 Nano。

  .venv/bin/python tests/eval/overlap/round2_tse_score.py

每种来源（ref / pya）算两种用法：
- 两路都用提取音：每人一路；
- 混合音 + 提取一路：混合音的识别结果照旧，再补上“窗口里说话时间较短的那个人”（按同一来源的说话人时间段判断，不看识别结果）的提取音。
pya 来源里窗口内只有一个系统说话人时，退回只识别混合音。
"""
import json, os, sys, tempfile, time
from pathlib import Path
import soundfile as sf

os.environ["MEETING_DATA"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parents[3])); sys.path.insert(0, str(Path(__file__).resolve().parent))
import asr_engine  # noqa: E402
import round2_common as C  # noqa: E402

eng = asr_engine.Engine(); eng.ensure("nano")
rd = lambda p: C.norm(eng._nano(sf.read(p, dtype="float32")[0])["text"])
ms = C.meta()
summary, all_rows = {}, {}
for src in ("ref", "pya"):
    d = C.OUT / f"tse-{src}"
    info = {r["k"]: r for r in json.loads((d / "meta.json").read_text())["rows"]}
    err = {"mix": 0, "both": 0, "mix_plus_minor": 0}; tot = 0; t_asr = 0.0; rows = []
    for m in ms:
        k = m["k"]; I = info[k]
        t = time.time()
        hm = rd(C.PROBE / f"{k:02d}_mix.wav")
        ht = [rd(d / f"{k:02d}_t{j}.wav") for j in range(len(I["spks"]))]
        t_asr += time.time() - t
        e = {"mix": C.score(m, [hm])}
        if len(ht) == 2:
            minor = min(range(2), key=lambda j: I["dur_in_win"][j])
            e["both"] = C.score(m, ht)
            e["mix_plus_minor"] = C.score(m, [hm, ht[minor]])
        else:
            e["both"] = e["mix_plus_minor"] = e["mix"]
        n = C.nref(m); tot += n
        for x in err:
            err[x] += e[x]
        rows.append({"k": k, "n": n, **e, "hyp_mix": hm, "hyp_tse": ht, "spks": I["spks"]})
        print(f"[{src}] {k:02d} {n:3d}字 混合 {e['mix'] / n:5.0%} 两路提取 {e['both'] / n:5.0%} 混合+补短的一路 {e['mix_plus_minor'] / n:5.0%}", flush=True)
    summary[src] = {f"cer_{x}": v / tot for x, v in err.items()} | {"chars": tot, "nano_s": t_asr}
    all_rows[src] = rows
(C.OUT / "tse_score.json").write_text(json.dumps({"summary": summary, "rows": all_rows}, ensure_ascii=False, indent=1))
print(json.dumps(summary, ensure_ascii=False, indent=1))
