"""同一批重叠片段，用 MossFormer2_SS_16K 分离，覆盖 sep-probe 里的 _s0/_s1（先备份 sepformer 的结果）。"""
import json, shutil
from pathlib import Path
import numpy as np, soundfile as sf
from clearvoice import ClearVoice
P = Path.home() / "eval-out/sep-probe"; B = Path.home() / "eval-out/sep-probe-sepformer"
if not B.exists():
    shutil.copytree(P, B)
cv = ClearVoice(task="speech_separation", model_names=["MossFormer2_SS_16K"])
meta = json.loads((P / "meta.json").read_text())
for m in meta:
    k = m["k"]
    y = cv(input_path=str(P / f"{k:02d}_mix.wav"), online_write=False)
    y = np.asarray(y if not isinstance(y, dict) else list(y.values())[0])
    y = y.reshape(2, -1) if y.size % 2 == 0 and y.ndim != 2 else y.squeeze()
    if y.shape[0] != 2: y = y.T
    for j in range(2):
        z = y[j] / (np.abs(y[j]).max() + 1e-9) * 0.5
        sf.write(P / f"{k:02d}_s{j}.wav", z.astype(np.float32), 16000)
    print(k, y.shape, flush=True)
