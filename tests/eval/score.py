"""给 run_pipeline.py 的输出打分，每个数都用两套以上互相独立的实现算，对不上就报出来。

  tests/eval/.venv/bin/python tests/eval/score.py --ref ~/eval-data/ali-test/ref --hyp ~/eval-out/ali-test-nano --out ~/eval-out/ali-test-nano-score

说话人（DER，含重叠语音）：
  - dscore（M2MeT 主办方用的打分器，内部调 NIST md-eval-22.pl），collar 0 和 0.25 秒；
  - pyannote.metrics（另一套独立实现）。
文字（CER，不分说话人）：参考按开始时间排序拼成一串（M2MeT 的 FIFO 做法），识别结果也按时间拼；
  去掉标点空白、全角转半角、英文大写后逐字比较：
  - NIST SCTK sclite；jiwer（rapidfuzz）；tests/audio/cer.py（我们自己的实现，要和前两个一致）。
谁说了什么（cpCER）：MeetEval 的 cpWER，按字切分。
"""
import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import jiwer
from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/audio"))
import cer as our_cer  # noqa: E402

SCLITE = Path.home() / "tools/SCTK/bin/sclite"
DSCORE = Path.home() / "tools/dscore/score.py"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).upper()
    return re.sub(r"[\W_]+", "", s)


def read_rttm(p: Path) -> Annotation:
    a = Annotation(uri=p.stem)
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            st, du = float(f[3]), float(f[4])
            a[Segment(st, st + du)] = f[7]
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--hyp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--skip-ours", action="store_true", help="不跑 cer.py（纯 Python，整场比较较慢）")
    o = ap.parse_args()
    ref, hyp, out = (Path(x).expanduser() for x in (o.ref, o.hyp, o.out))
    (out / "sys").mkdir(parents=True, exist_ok=True)
    sessions = sorted(p.stem for p in hyp.glob("*.json") if (ref / f"{p.stem}.rttm").exists())
    rows, ref_trn, hyp_trn, ref_stm, hyp_stm = [], [], [], [], []
    for s in sessions:
        h = json.loads((hyp / f"{s}.json").read_text())
        with open(out / "sys" / f"{s}.rttm", "w") as f:
            for a, b, spk in h["turns"]:
                if b > a:
                    f.write(f"SPEAKER {s} 1 {a / 1000:.3f} {(b - a) / 1000:.3f} <NA> <NA> spk{spk} <NA> <NA>\n")
        ref_rows = [ln.split(" ", 5) for ln in (ref / f"{s}.stm").read_text(encoding="utf-8").splitlines()]
        ref_rows = [(float(r[3]), float(r[4]), r[2], r[5] if len(r) > 5 else "") for r in ref_rows]
        r_txt = norm("".join(t for *_, t in sorted(ref_rows, key=lambda r: (r[0], r[1]))))
        h_txt = norm("".join(p["text"] for p in sorted(h["paras"], key=lambda p: (p["start"], p["end"]))))
        ref_trn.append(f"{' '.join(r_txt)} ({s})")
        hyp_trn.append(f"{' '.join(h_txt)} ({s})")
        for r in (ref / f"{s}.stm").read_text(encoding="utf-8").splitlines():
            f = r.split(" ", 5)
            t = norm(f[5]) if len(f) > 5 else ""
            if t:
                ref_stm.append(f"{s} 1 {f[2]} {f[3]} {f[4]} {' '.join(t)}")
        for p in h["paras"]:
            t = norm(p["text"])
            if t:
                hyp_stm.append(f"{s} 1 spk{p['spk']} {p['start'] / 1000:.2f} {p['end'] / 1000:.2f} {' '.join(t)}")
        m = jiwer.process_characters(r_txt, h_txt)
        row = {"session": s, "min": round(h["duration_s"] / 60, 1), "ref_spk": len({r[2] for r in ref_rows}),
               "hyp_spk": len({p["spk"] for p in h["paras"]}), "ref_chars": len(r_txt),
               "cer_jiwer": (m.substitutions + m.deletions + m.insertions) / len(r_txt), "sub": m.substitutions,
               "del": m.deletions, "ins": m.insertions, "rtf": h["cost_s"] / h["duration_s"]}
        if not o.skip_ours:
            S, D, I = our_cer.edit_ops(r_txt, h_txt)
            row["cer_ours"] = (S + D + I) / len(r_txt)
        rows.append(row)
        print(s, f"CER {row['cer_jiwer'] * 100:.2f}%", flush=True)
    (out / "ref.trn").write_text("\n".join(ref_trn) + "\n", encoding="utf-8")
    (out / "hyp.trn").write_text("\n".join(hyp_trn) + "\n", encoding="utf-8")
    (out / "ref.stm").write_text("\n".join(ref_stm) + "\n", encoding="utf-8")
    (out / "hyp.stm").write_text("\n".join(hyp_stm) + "\n", encoding="utf-8")

    res = {"sessions": len(rows)}
    tot = sum(r["ref_chars"] for r in rows)
    res["cer_jiwer"] = sum(r["sub"] + r["del"] + r["ins"] for r in rows) / tot
    if not o.skip_ours:
        res["cer_ours"] = sum(r["cer_ours"] * r["ref_chars"] for r in rows) / tot
    sc = subprocess.run([str(SCLITE), "-r", str(out / "ref.trn"), "trn", "-h", str(out / "hyp.trn"), "trn", "-i", "rm",
                         "-o", "dtl", "stdout"], capture_output=True, text=True).stdout
    mt = re.search(r"Percent Total Error\s*=\s*([\d.]+)%\s*\(\s*(\d+)\)", sc)
    res["cer_sclite"] = float(mt.group(1)) / 100 if mt else None
    res["sclite_errors"] = int(mt.group(2)) if mt else None
    res["jiwer_errors"] = sum(r["sub"] + r["del"] + r["ins"] for r in rows)

    cp = subprocess.run([str(Path(sys.executable).parent / "meeteval-wer"), "cpwer", "-r", str(out / "ref.stm"), "-h",
                         str(out / "hyp.stm"), "--average-out", str(out / "cpcer.json"), "--per-reco-out",
                         str(out / "cpcer_per.json")], capture_output=True, text=True)
    if (out / "cpcer.json").exists():
        res["cpcer"] = json.loads((out / "cpcer.json").read_text())["error_rate"]
    else:
        res["cpcer_error"] = cp.stderr[-500:]

    for collar in (0.0, 0.25):
        refs = [str(ref / f"{s}.rttm") for s in sessions]
        syss = [str(out / "sys" / f"{s}.rttm") for s in sessions]
        d = subprocess.run([sys.executable, str(DSCORE), "--collar", str(collar), "-r", *refs, "-s", *syss],
                           capture_output=True, text=True, cwd=DSCORE.parent)
        mo = re.search(r"\*\*\* OVERALL \*\*\*\s+([\d.]+)", d.stdout)
        res[f"der_dscore_c{collar}"] = float(mo.group(1)) / 100 if mo else d.stderr[-300:]
        (out / f"dscore_c{collar}.txt").write_text(d.stdout)
        metric = DiarizationErrorRate(collar=2 * collar, skip_overlap=False)
        for s in sessions:
            metric(read_rttm(ref / f"{s}.rttm"), read_rttm(out / "sys" / f"{s}.rttm"))
        det = metric[:]
        T = det["total"]
        res[f"der_pyannote_c{collar}"] = abs(metric)
        res[f"der_parts_c{collar}"] = {k: det[k] / T for k in ("missed detection", "false alarm", "confusion")}
        per = {s: metric.results_[i][1] for i, s in enumerate(sessions)} if hasattr(metric, "results_") else {}
        for r in rows:
            if r["session"] in per:
                c = per[r["session"]]
                r[f"der_c{collar}"] = (c["missed detection"] + c["false alarm"] + c["confusion"]) / c["total"]
    (out / "summary.json").write_text(json.dumps({"overall": res, "per_session": rows}, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
