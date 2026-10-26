"""第 2 项（按说话人拆句）的离线实验：用 run_pipeline.py 存下的 Nano 原始输出（nano_raw）和说话人时间段（turns），
按产品自己的 Engine._clauses / _assign_speakers / _paragraphs 重新定说话人，算 cpCER（MeetEval）。不重跑模型。

  .venv/bin/python tests/eval/split_sweep.py --ref ~/eval-data/ali-eval/ref --hyp ~/eval-out/r1-eval-vad --min-ms 0 1000 2000 3000
  [--turns-dir 目录]：换一套说话人时间段（每场一个 <场次>.rttm，没有重叠），比如别的说话人分离方案的输出

min-ms 0 就是产品现状，必须和 run_pipeline 存下的段落完全一致（脚本会检查），否则说明离线模拟和产品对不上。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-eval-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import asr_engine  # noqa: E402

E = asr_engine.Engine
MEETEVAL = Path(__file__).resolve().parent / ".venv/bin/meeteval-wer"


def norm(s: str) -> str:  # 同 score.py
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).upper())


def read_turns(p: Path) -> list[tuple]:
    out, names = [], {}
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            st, du = float(f[3]), float(f[4])
            out.append((int(st * 1000), int((st + du) * 1000), names.setdefault(f[7], len(names))))
    return sorted(out)


def paras_for(h: dict, turns: list, min_ms: float) -> list[dict]:
    clauses = []
    for r in h["nano_raw"]:
        clauses += E._clauses(r["text"], r["toks"], r["s"], r["e"])
    return E._paragraphs(E._assign_speakers(clauses, turns, min_ms))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--hyp", required=True)
    ap.add_argument("--min-ms", type=float, nargs="+", default=[0, 1000, 2000, 3000])
    ap.add_argument("--turns-dir", default=None)
    ap.add_argument("--out", default=None, help="写每个方案的 hyp.stm 和逐场 cpCER；默认临时目录")
    o = ap.parse_args()
    ref, hyp = Path(o.ref).expanduser(), Path(o.hyp).expanduser()
    out = Path(o.out).expanduser() if o.out else Path(tempfile.mkdtemp(prefix="split-"))
    out.mkdir(parents=True, exist_ok=True)
    sessions = sorted(p.stem for p in hyp.glob("*.json") if (ref / f"{p.stem}.stm").exists())
    ref_stm = []
    for s in sessions:
        for r in (ref / f"{s}.stm").read_text(encoding="utf-8").splitlines():
            f = r.split(" ", 5)
            t = norm(f[5]) if len(f) > 5 else ""
            if t:
                ref_stm.append(f"{s} 1 {f[2]} {f[3]} {f[4]} {' '.join(t)}")
    (out / "ref.stm").write_text("\n".join(ref_stm) + "\n", encoding="utf-8")
    H = {s: json.loads((hyp / f"{s}.json").read_text()) for s in sessions}
    T = {s: (read_turns(Path(o.turns_dir).expanduser() / f"{s}.rttm") if o.turns_dir else [tuple(t) for t in H[s]["turns"]])
         for s in sessions}
    if not o.turns_dir:  # 现状必须和产品存下的段落一致
        for s in sessions:
            got = [(p["spk"], p["start"], p["end"], p["text"]) for p in paras_for(H[s], T[s], 0)]
            want = [(p["spk"], p["start"], p["end"], p["text"]) for p in H[s]["paras"]]
            if got != want:
                sys.exit(f"{s}：离线模拟（min-ms 0）和产品存下的段落对不上，先查原因")
        print(f"核对通过：min-ms 0 和产品输出一致（{len(sessions)} 场）")
    res = {}
    for m in o.min_ms:
        d = out / f"m{int(m)}"
        d.mkdir(exist_ok=True)
        lines, nsplit = [], 0
        for s in sessions:
            ps = paras_for(H[s], T[s], m)
            for p in ps:
                t = norm(p["text"])
                if t:
                    lines.append(f"{s} 1 spk{p['spk']} {p['start'] / 1000:.2f} {p['end'] / 1000:.2f} {' '.join(t)}")
            nsplit += len(ps)
        (d / "hyp.stm").write_text("\n".join(lines) + "\n", encoding="utf-8")
        subprocess.run([str(MEETEVAL), "cpwer", "-r", str(out / "ref.stm"), "-h", str(d / "hyp.stm"),
                        "--average-out", str(d / "cpcer.json"), "--per-reco-out", str(d / "cpcer_per.json")],
                       capture_output=True, text=True, check=True)
        cp = json.loads((d / "cpcer.json").read_text())
        per = json.loads((d / "cpcer_per.json").read_text())
        res[m] = {"cpcer": cp["error_rate"], "paras": nsplit, "per": {k: v["error_rate"] for k, v in per.items()}}
        print(f"min-ms {int(m):>5}: cpCER {cp['error_rate']:.2%}，段落 {nsplit}", flush=True)
    (out / "summary.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print("明细：", out)


if __name__ == "__main__":
    main()
