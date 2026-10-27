"""给 spk_sweep_r2.py 的候选打分（docs/improvements.md 第二轮第 4 项）。用 tests/eval/.venv。

  .venv/bin/python spk_score_r2.py --sweep ~/eval-out/spk-sweep-r2 --sets ali-eval a4-trainL weekly [--cands base Q12 ...]
人数照 spk_score.py 的数法（过 _speaker_units 后剩下的人，spk_sweep_r2 已经算好）；DER 用 pyannote，collar 0.25（pyannote 写 0.5），含重叠。
"""
import argparse
import json
from pathlib import Path

from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate

H = Path.home()
SETS = {"ali-eval": H / "eval-data/ali-eval/ref", "ali-test": H / "eval-data/ali-test/ref",
        "a4-trainL": H / "eval-data/aishell4/train_L/ref", "a4-test": H / "eval-data/aishell4/test/ref"}


def read_rttm(p, uri=None):
    a = Annotation(uri=uri or p.stem)
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            st, du = float(f[3]), float(f[4])
            a[Segment(st, st + du)] = f[7]
    return a


ap = argparse.ArgumentParser()
ap.add_argument("--sweep", required=True)
ap.add_argument("--sets", nargs="+", required=True)
ap.add_argument("--cands", nargs="*", default=None)
ap.add_argument("--detail", action="store_true")
o = ap.parse_args()
sw = Path(o.sweep).expanduser()
counts = json.loads((sw / "counts.json").read_text())
cands = o.cands or list(counts)
print(f"{'':10}" + "".join(f"{s:>30}" for s in o.sets))
print(f"{'':10}" + "".join(f"{'判对':>9}{'误差':>8}{'DER':>9}  " for _ in o.sets))
for c in cands:
    cells = []
    for s in o.sets:
        if s == "weekly":
            sess = [("weekly-1023", H / "eval-out/spk-ref/weekly-1023.rttm", 6)]
        else:
            sess = [(p.stem, p, None) for p in sorted(SETS[s].glob("*.rttm"))]
        m = DiarizationErrorRate(collar=0.5, skip_overlap=False)
        ok = err = n = 0
        rows = []
        for name, rp, true_n in sess:
            hp = sw / c / f"{name}.rttm"
            if not hp.exists() or name not in counts.get(c, {}):
                continue
            ref = read_rttm(rp, name)
            m(ref, read_rttm(hp, name))
            tn = true_n or len(ref.labels())
            est = counts[c][name]["n"]
            ok += tn == est; err += abs(tn - est); n += 1
            rows.append((name, tn, est))
        cells.append(f"{ok:>5}/{n:<3}{err / max(n, 1):>8.3f}{abs(m) if n else float('nan'):>9.2%}  ")
        if o.detail:
            print(c, s, rows)
    print(f"{c:10}" + "".join(cells))
