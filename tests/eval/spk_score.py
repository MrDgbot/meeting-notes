"""给 spk_sweep.py 的每个方案打分（docs/prereg-deviations.md D5）。

  .venv/bin/python spk_score.py --sweep ~/eval-out/spk-sweep            # 只看开发集：AliMeeting Eval 8 场 + 周会
  .venv/bin/python spk_score.py --sweep ~/eval-out/spk-sweep --final 方案名  # 选定后才看留出集 AliMeeting Test 20 场（现状 vs 选定方案）

人数 = 过一遍 _speaker_units 之后剩下的说话人数（spk_sweep 里算好的）。DER 用 pyannote，collar 0.25（pyannote 写 0.5，同 score.py），含重叠。
周会的参考是飞书逐字稿的说话人（句子级时间、没有重叠），人数按 6。
"""
import argparse
import json
from pathlib import Path

from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate

H = Path.home()
BASE = "nkeep_m0_t0.78_s0"


def read_rttm(p):
    a = Annotation(uri=p.stem)
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            st, du = float(f[3]), float(f[4])
            a[Segment(st, st + du)] = f[7]
    return a


def weekly_ref():
    p = H / "eval-out/spk-ref/weekly-1023.rttm"
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        F = json.loads((H / "eval-out/weekly-1023-feishu/audio16k.json").read_text())["sents"]
        p.write_text("".join(f"SPEAKER weekly-1023 1 {x['start'] / 1000:.3f} {(x['end'] - x['start']) / 1000:.3f} <NA> <NA> f{x['spk']} <NA> <NA>\n"
                             for x in F if x["end"] > x["start"]))
    return p


REF = {"eval": H / "eval-data/ali-eval/ref", "test": H / "eval-data/ali-test/ref"}


def score(sweep, name, sessions, counts):
    m = DiarizationErrorRate(collar=0.5, skip_overlap=False)
    rows = []
    for s, rp in sessions:
        ref = read_rttm(rp)
        hp = sweep / name / f"{s}.rttm"
        hyp = read_rttm(hp) if hp.exists() else Annotation(uri=s)
        c = m(ref, hyp, detailed=True)
        true_n = 6 if s == "weekly-1023" else len(ref.labels())
        est = counts[name][s]["n_units_spk"]
        rows.append({"s": s, "true": true_n, "est": est, "der": (c["missed detection"] + c["false alarm"] + c["confusion"]) / c["total"],
                     "conf": c["confusion"] / c["total"]})
    det = m[:]
    return {"der": abs(m), "conf": det["confusion"] / det["total"], "ok": sum(r["true"] == r["est"] for r in rows),
            "mae": sum(abs(r["true"] - r["est"]) for r in rows) / len(rows), "rows": rows}


ap = argparse.ArgumentParser()
ap.add_argument("--sweep", required=True)
ap.add_argument("--final", default=None)
o = ap.parse_args()
sweep = Path(o.sweep).expanduser()
counts = json.loads((sweep / "counts.json").read_text())
ev = [(p.stem, p) for p in sorted(REF["eval"].glob("*.rttm"))]
wk = [("weekly-1023", weekly_ref())]
if o.final is None:
    res = {}
    for name in sorted(counts):
        if not all(s in counts[name] for s, _ in ev + wk):
            continue
        e, w = score(sweep, name, ev, counts), score(sweep, name, wk, counts)
        res[name] = {"eval": e, "weekly": w}
    b = res[BASE]
    print(f"{'方案':26} {'开发集人数对':>8} {'人数误差':>8} | {'Eval 人数对':>9} {'Eval DER':>9} {'Eval 认错':>9} | {'周会人数':>6} {'周会 DER':>8}")
    for name, r in sorted(res.items(), key=lambda kv: (-(kv[1]["eval"]["ok"] + kv[1]["weekly"]["ok"]),
                                                      (kv[1]["eval"]["mae"] * 8 + kv[1]["weekly"]["mae"]) / 9, kv[1]["eval"]["der"])):
        e, w = r["eval"], r["weekly"]
        guard = "" if e["der"] <= b["eval"]["der"] + 0.005 else "  ✗DER护栏"
        print(f"{name:26} {e['ok'] + w['ok']:>8}/9 {(e['mae'] * 8 + w['mae']) / 9:>8.2f} | {e['ok']:>7}/8 {e['der']:>9.2%} {e['conf']:>9.2%} | "
              f"{w['rows'][0]['est']:>6} {w['der']:>8.2%}{guard}{'  ←现状' if name == BASE else ''}")
    print("\n现状逐场（真/估）：", [(r["s"][:14], r["true"], r["est"]) for r in b["eval"]["rows"]])
    (sweep / "dev_scores.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
else:
    te = [(p.stem, p) for p in sorted(REF["test"].glob("*.rttm"))]
    out = {}
    for name in (BASE, o.final):
        r = score(sweep, name, te, counts)
        out[name] = r
        print(f"{name:26} Test 人数对 {r['ok']}/20，人数误差 {r['mae']:.2f}，DER {r['der']:.2%}，认错 {r['conf']:.2%}")
    b, f = out[BASE], out[o.final]
    print("判定：", "改进" if f["ok"] >= b["ok"] and f["der"] <= b["der"] + 0.005 else "不算改进",
          "（人数判对不少于现状，且 DER 不差超过 0.5 个百分点）")
    for rb, rf in zip(b["rows"], f["rows"]):
        print(f"  {rb['s'][:18]:18} 真 {rb['true']}  现状 {rb['est']}  新 {rf['est']}   DER {rb['der']:.1%} → {rf['der']:.1%}")
    (sweep / "test_scores.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
