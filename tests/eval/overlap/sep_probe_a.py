"""重叠可行性探针（第 3 项）：从开发集参考里挑两人真重叠的片段，存混合音和 sepformer 分出的两路。"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf, torch
from speechbrain.inference.separation import SepformerSeparation
D = Path.home() / "eval-data/ali-eval"; OUT = Path.home() / "eval-out/sep-probe"
def stm(p):
    r = []
    for ln in p.read_text().splitlines():
        f = ln.split(maxsplit=5)
        if len(f) == 6: r.append((f[2], float(f[3]), float(f[4]), f[5]))
    return r
cands = []
for p in sorted((D / "ref").glob("*.stm")):
    R = stm(p)
    for i, a in enumerate(R):
        for b in R[i + 1:]:
            if b[1] >= a[2]: continue
            if a[0] == b[0]: continue
            ov = min(a[2], b[2]) - max(a[1], b[1])
            lo, hi = min(a[1], b[1]), max(a[2], b[2])
            if ov < 2.0 or hi - lo > 12: continue
            third = [c for c in R if c[0] not in (a[0], b[0]) and min(c[2], hi) - max(c[1], lo) > 0.3]
            same = [c for c in R if c not in (a, b) and c[0] in (a[0], b[0]) and min(c[2], hi) - max(c[1], lo) > 0.3]
            if third or same: continue
            cands.append((p.stem, lo, hi, a, b, ov))
rng = np.random.default_rng(0)
pick = [cands[i] for i in sorted(rng.choice(len(cands), size=min(30, len(cands)), replace=False))]
print("candidates", len(cands), "picked", len(pick))
m = SepformerSeparation.from_hparams(source="speechbrain/sepformer-whamr16k", savedir=str(Path.home() / "eval-out/pya/sepformer-whamr16k"), run_opts={"device": sys.argv[1] if len(sys.argv) > 1 else "cpu"})
meta = []
for k, (s, lo, hi, a, b, ov) in enumerate(pick):
    x, sr = sf.read(D / "wav" / f"{s}.wav", dtype="float32", start=int(lo * 16000), stop=int(hi * 16000))
    sf.write(OUT / f"{k:02d}_mix.wav", x, sr)
    y = m.separate_batch(torch.from_numpy(x)[None]).squeeze(0).T.detach().cpu().numpy()
    for j in range(2):
        z = y[j] / (np.abs(y[j]).max() + 1e-9) * 0.5
        sf.write(OUT / f"{k:02d}_s{j}.wav", z.astype(np.float32), sr)
    meta.append({"k": k, "session": s, "lo": lo, "hi": hi, "ov": ov, "refA": a[3], "refB": b[3]})
    print(k, s, f"{hi - lo:.1f}s ov {ov:.1f}s", flush=True)
(OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
