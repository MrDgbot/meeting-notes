from collections import Counter
from pathlib import Path
from pyannote.core import Annotation, Segment, Timeline
from pyannote.metrics.diarization import DiarizationErrorRate
H = Path.home()
def rttm(p):
    a = Annotation()
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER": a[Segment(float(f[3]), float(f[3]) + float(f[4]))] = f[7]
    return a
def nspk(a, uem=None):
    c = Counter()
    for seg, _, s in (a.crop(uem) if uem else a).itertracks(yield_label=True): c[s] += seg.duration
    return sum(v >= 30 for v in c.values())
sys_ = {"现状 CAM++(level all)": None, **{k: Path("/tmp/merge-eval") / k for k in ("raw", "t0.66", "t0.72", "t0.78")}}
for name, d in sys_.items():
    m = DiarizationErrorRate(collar=0.5, skip_overlap=False); ok = 0; err = []
    for r in sorted((H / "eval-data/ali-eval/ref").glob("*.rttm")):
        s = r.stem; R = rttm(r)
        if d is None:
            import json
            h = json.loads((H / f"eval-out/r1-eval-all/{s}.json").read_text())["turns"]
            Hh = Annotation()
            for a, b, k in h: Hh[Segment(a / 1000, b / 1000)] = f"c{k}"
        else:
            Hh = rttm(d / f"{s}.rttm")
        m(R, Hh); n = nspk(Hh); nr = len(R.labels()); ok += n == nr; err.append(abs(n - nr))
    W = rttm(H / "eval-out/spk-ref/weekly-1023.rttm")
    if d is None:
        Wh = rttm(H / "eval-out/spk-sweep/nassign_m30_t0.72_s0/weekly-1023.rttm"); wname = "(D5)"
    else:
        Wh = rttm(d / "weekly-1023.rttm"); wname = ""
    uem = Timeline([Segment(870, max(s.end for s in W.get_timeline()))])
    wd = DiarizationErrorRate(collar=0.5, skip_overlap=False)(W, Wh, uem=uem)
    print(f"{name:22} 开发集 DER {abs(m):.2%} 人数判对 {ok}/8 平均误差 {sum(err) / 8:.3f} | 周会{wname} DER {wd:.1%} 人数 {nspk(Wh, uem)}（飞书 6）")
