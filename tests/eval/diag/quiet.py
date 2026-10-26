import json, sys, numpy as np, soundfile as sf
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_stm, ovl_frac
for sess in ["R8008_M8015_MS808", "R8008_M8014_MS807", "R8008_M8016_MS808", "R8009_M8022_MS810"]:
    ref = read_stm(Path.home() / f"eval-data/ali-test/ref/{sess}.stm")
    x, sr = sf.read(Path.home() / f"eval-data/ali-test/wav/{sess}.wav", dtype="float32")
    d = json.loads((Path.home() / f"eval-out/ali-test-nano/{sess}.json").read_text())
    vad = np.zeros(len(x) // 160 + 1, bool)
    for a, b in d["vad_segs"]: vad[a // 10:b // 10] = True
    hypc = np.zeros_like(vad)
    for s in d["sents"]: hypc[s["start"] // 10:s["end"] // 10] = True
    print(sess)
    for spk in sorted({r[0] for r in ref}):
        segs = [r for r in ref if r[0] == spk and ovl_frac(r, ref) == 0]
        lv, cov, hc, dur = [], 0, 0, 0
        for _, s, e, _t in segs:
            seg = x[int(s * sr):int(e * sr)]
            lv.append(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9))
            fs, fe = int(s * 100), int(e * 100); cov += vad[fs:fe].sum(); hc += hypc[fs:fe].sum(); dur += fe - fs
        print(f"  {spk}: 单人段 {len(segs)} 个 {dur / 100:.0f}s，中位音量 {np.median(lv):.1f} dBFS，VAD 覆盖 {cov / dur:.0%}，有识别句覆盖 {hc / dur:.0%}")
