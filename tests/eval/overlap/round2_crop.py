"""第 3 项第二轮 · 方法 A（启发式）：按说话人时间段裁窗口，各自再识别一遍。

想法：重叠处 Nano 主要认出“占主导”的那个人；如果把窗口裁成某个人自己那句话的起止，
这个人在窗口里占的时间更多，Nano 可能更倾向于认他。每人一路，两路一起打分（和第一轮的“分离两路”同一个打分法）。

  .venv/bin/python tests/eval/overlap/round2_crop.py

ref = 用参考标注的两句话的起止（作弊上限）；pya = 用 pyannote（含重叠）系统输出的说话人时间段，裁到同一个 [lo, hi] 窗口里。
"""
import json, os, sys, tempfile, time
from pathlib import Path
import soundfile as sf

os.environ["MEETING_DATA"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parents[3])); sys.path.insert(0, str(Path(__file__).resolve().parent))
import asr_engine  # noqa: E402
import round2_common as C  # noqa: E402

eng = asr_engine.Engine(); eng.ensure("nano")
ms = C.meta()
wavs = {}


def nano(sess, a, b):
    if sess not in wavs:
        wavs[sess] = sf.read(C.D / "wav" / f"{sess}.wav", dtype="float32")[0]
    x = wavs[sess][int(a * 16000):int(b * 16000)]
    return C.norm(eng._nano(x)["text"]) if len(x) > 3200 else ""


def sys_spans(m, gap=0.3, min_dur=0.3):
    """pyannote 含重叠的说话人时间段，裁到 [lo, hi]，同一人间隔小于 gap 的连起来，每人取一个总的起止。"""
    by = {}
    for spk, a, b in C.rttm(Path.home() / f"eval-out/pya/eval/{m['session']}.ovl.rttm"):
        a, b = max(a, m["lo"]), min(b, m["hi"])
        if b - a > 0:
            by.setdefault(spk, []).append((a, b))
    out = []
    for spk, v in by.items():
        if sum(b - a for a, b in v) >= min_dur:
            out.append((spk, min(a for a, _ in v), max(b for _, b in v)))
    return out


res = {k: 0 for k in ("mix", "ref", "pya")}
cost = {k: 0.0 for k in res}
tot = 0
rows = []
for m in ms:
    s = m["session"]
    t = time.time(); hm = nano(s, m["lo"], m["hi"]); cost["mix"] += time.time() - t
    t = time.time(); hr = [nano(s, m["stA"], m["enA"]), nano(s, m["stB"], m["enB"])]; cost["ref"] += time.time() - t
    sp = sys_spans(m)
    t = time.time(); hp = [nano(s, a, b) for _, a, b in sp] if len(sp) > 1 else [hm]; cost["pya"] += time.time() - t
    e = {"mix": C.score(m, [hm]), "ref": C.score(m, hr), "pya": C.score(m, hp)}
    n = C.nref(m); tot += n
    for k in res:
        res[k] += e[k]
    rows.append({"k": m["k"], "n": n, **e, "hyp_mix": hm, "hyp_ref": hr, "hyp_pya": hp, "pya_spans": sp})
    print(f"{m['k']:02d} {n:3d}字 混合 {e['mix'] / n:5.0%} 按参考裁 {e['ref'] / n:5.0%} 按pyannote裁 {e['pya'] / n:5.0%}（{len(sp)} 人）", flush=True)
summary = {"chars": tot, **{f"cer_{k}": v / tot for k, v in res.items()}, **{f"nano_s_{k}": v for k, v in cost.items()},
           "audio_s": sum(m["hi"] - m["lo"] for m in ms)}
(C.OUT / "crop").mkdir(exist_ok=True)
(C.OUT / "crop/rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
(C.OUT / "crop/summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
print(json.dumps(summary, ensure_ascii=False))
