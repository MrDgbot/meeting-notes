import json, os, sys, tempfile
from collections import Counter
from pathlib import Path
import numpy as np
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import asr_engine
H = Path.home()
def turns_rttm(p):
    out, names = [], {}
    for ln in p.read_text().splitlines():
        f = ln.split()
        if f and f[0] == "SPEAKER":
            out.append((int(float(f[3]) * 1000), int((float(f[3]) + float(f[4])) * 1000), names.setdefault(f[7], len(names))))
    return out
def write(turns, p, uri):
    p.write_text("".join(f"SPEAKER {uri} 1 {a / 1000:.3f} {(b - a) / 1000:.3f} <NA> <NA> s{s} <NA> <NA>\n" for a, b, s in turns if b > a))
out = Path("/tmp/merge-eval"); out.mkdir(exist_ok=True)
for thr in (None, 0.66, 0.72, 0.78):
    tag = "raw" if thr is None else f"t{thr}"
    d = out / tag; d.mkdir(exist_ok=True)
    for npz in sorted((H / "eval-out/r1-eval-all").glob("*.npz")):
        s = npz.stem; z = np.load(npz)
        T = turns_rttm(H / f"eval-out/pya/eval-excl/{s}.rttm")
        if thr is not None: T = asr_engine.merge_turn_speakers(T, z["t"].tolist(), z["X"], thr)
        write(T, d / f"{s}.rttm", s)
    z = np.load(H / "eval-out/spk-cache/weekly-1023.npz")
    T = [tuple(t) for t in json.loads((H / "eval-out/pya/weekly-1023.json").read_text())["turns"]]
    if thr is not None: T = asr_engine.merge_turn_speakers(T, z["t"].tolist(), z["X"], thr)
    write(T, d / "weekly-1023.rttm", "weekly-1023")
print("written", out)
