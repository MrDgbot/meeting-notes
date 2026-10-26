import json, sys
from pathlib import Path
from pyannote.core import Annotation, Segment
from pyannote.metrics.diarization import DiarizationErrorRate
def rttm(p):
    a = Annotation(uri=p.stem)
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            a[Segment(float(f[3]), float(f[3]) + float(f[4]))] = f[7]
    return a
split, d = sys.argv[1], Path(sys.argv[2])
ref = Path.home() / f"eval-data/{split}/ref"
for kind in ("ovl", "excl"):
    for collar in (0.0, 0.25):
        m = DiarizationErrorRate(collar=2 * collar, skip_overlap=False)
        right = 0; errs = []; cost = dur = 0
        for j in sorted(d.glob("*.json")):
            s = j.stem; R = rttm(ref / f"{s}.rttm"); H = rttm(d / f"{s}.{kind}.rttm")
            m(R, H)
            nr = len(R.labels()); nh = len([l for l in H.labels() if H.label_duration(l) >= 30])
            right += nr == nh; errs.append(abs(nr - nh))
            jj = json.loads(j.read_text()); cost += jj["cost_s"]; dur += jj["dur_s"]
        det = m[:]; T = det["total"]
        print(f"{kind:4} collar {collar}: DER {abs(m):.2%}（漏 {det['missed detection'] / T:.1%} 误报 {det['false alarm'] / T:.1%} 认错 {det['confusion'] / T:.1%}）人数判对 {right}/{len(errs)} 平均误差 {sum(errs) / len(errs):.2f}  耗时/时长 {cost / dur:.3f}")
