"""pyannote community-1 跑一批 wav：写出含重叠的 RTTM 和“每刻一人”的 RTTM，记耗时。"""
import sys, time, json
from pathlib import Path
import numpy as np, soundfile as sf, torch
from pyannote.audio import Pipeline
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
dev = sys.argv[2] if len(sys.argv) > 2 else "mps"
t0 = time.time()
pipe = Pipeline.from_pretrained("pyannote-community/speaker-diarization-community-1")
pipe.to(torch.device(dev))
print("loaded", round(time.time() - t0, 1), flush=True)
for w in map(Path, sys.argv[3:]):
    if (out / f"{w.stem}.json").exists():
        continue
    x, sr = sf.read(w, dtype="float32")
    t = time.time()
    r = pipe({"waveform": torch.from_numpy(x)[None], "sample_rate": sr})
    cost = time.time() - t
    for name, ann in (("ovl", r.speaker_diarization), ("excl", r.exclusive_speaker_diarization)):
        with open(out / f"{w.stem}.{name}.rttm", "w") as f:
            for seg, _, spk in ann.itertracks(yield_label=True):
                f.write(f"SPEAKER {w.stem} 1 {seg.start:.3f} {seg.duration:.3f} <NA> <NA> {spk} <NA> <NA>\n")
    emb = getattr(r, "speaker_embeddings", None)
    (out / f"{w.stem}.json").write_text(json.dumps({"cost_s": cost, "dur_s": len(x) / sr, "n_spk": len(r.speaker_diarization.labels())}))
    if emb is not None:
        np.save(out / f"{w.stem}.emb.npy", np.asarray(emb))
    print(w.stem, f"{len(x) / sr / 60:.1f}min cost {cost:.0f}s spk {len(r.speaker_diarization.labels())}", flush=True)
