"""只跑 VAD：几种音量处理下，参考语音被 VAD 覆盖的比例（召回）、单人段召回、误报。"""
import json, subprocess, sys, tempfile, numpy as np, soundfile as sf
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent)); sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from common import read_stm, ovl_frac
from funasr import AutoModel
SPLIT = sys.argv[1]; D = Path.home() / f"eval-data/{SPLIT}"
KW = dict(model="fsmn-vad", max_single_segment_time=30000, device="cpu", disable_update=True, disable_pbar=True, disable_log=True)
base = AutoModel(**KW)
fixed = {t: AutoModel(**KW, max_end_silence_time=800, speech_noise_thres=t) for t in (0.6, 0.4)}

def gain(x, target=-30.0):
    r = 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9); g = 10 ** ((target - r) / 20)
    return np.tanh(x * g).astype(np.float32), target - r

def dyn(path):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-af", "dynaudnorm=f=200:g=15:p=0.9", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, np.float32).copy()

variants = {"现状": lambda x, p: (base, x), "整体增益": lambda x, p: (base, gain(x)[0]),
            "dynaudnorm": lambda x, p: (base, dyn(p)), "修阈值0.6": lambda x, p: (fixed[0.6], x),
            "修阈值0.4": lambda x, p: (fixed[0.4], x), "dynaudnorm+修阈值0.6": lambda x, p: (fixed[0.6], dyn(p))}
res = {k: {"ref": 0, "hit": 0, "solo": 0, "solohit": 0, "fa": 0, "worst": []} for k in variants}
for wav in sorted((D / "wav").glob("*.wav")):
    x, sr = sf.read(wav, dtype="float32"); n = len(x) // 160 + 1
    ref = read_stm(D / "ref" / f"{wav.stem}.stm")
    refm = np.zeros(n, bool); solo = {}
    for r in ref:
        refm[int(r[1] * 100):int(r[2] * 100)] = True
        if ovl_frac(r, ref) == 0:
            m = solo.setdefault(r[0], np.zeros(n, bool)); m[int(r[1] * 100):int(r[2] * 100)] = True
    line = [wav.stem, f"{gain(x)[1]:+.0f}dB"]
    for k, f in variants.items():
        vad, y = f(x, wav)
        vm = np.zeros(n, bool)
        for a, b in vad.generate(input=y)[0]["value"]: vm[a // 10:b // 10] = True
        R = res[k]; R["ref"] += refm.sum(); R["hit"] += (refm & vm).sum(); R["fa"] += (vm & ~refm).sum()
        per = {s: (m & vm).sum() / max(m.sum(), 1) for s, m in solo.items()}
        R["solo"] += sum(m.sum() for m in solo.values()); R["solohit"] += sum((m & vm).sum() for m in solo.values())
        R["worst"].append(min(per.values())); line.append(f"{k}:{min(per.values()):.0%}")
    print(" ".join(line), flush=True)
print(f"\n{'做法':<22}{'语音召回':>8}{'单人段召回':>10}{'误报/语音':>10}{'各场最差的人(中位/最低)':>18}")
for k, R in res.items():
    w = np.array(R["worst"])
    print(f"{k:<22}{R['hit'] / R['ref']:>9.1%}{R['solohit'] / R['solo']:>11.1%}{R['fa'] / R['ref']:>11.1%}{np.median(w):>12.0%} / {w.min():.0%}")
