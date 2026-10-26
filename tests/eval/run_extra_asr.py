"""给“取证”用的另外两路识别：SenseVoice、Paraformer（都只识别文字，不分说话人）。

  .venv/bin/python tests/eval/run_extra_asr.py --out ~/eval-out/extra-asr <wav...>

切分：fsmn-vad，每段最长 30 秒，max_end_silence_time=800（关掉 FunASR 的动态静音，阈值用模型默认 0.6；
。每段分别送两个模型，输出 <out>/<engine>/<名字>.json：{"sents": [{start, end, text}]}。
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from funasr import AutoModel

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("wavs", nargs="+")
o = ap.parse_args()
out = Path(o.out).expanduser()
kw = dict(disable_update=True, disable_pbar=True, disable_log=True)
vad = AutoModel(model="fsmn-vad", max_single_segment_time=30000, max_end_silence_time=800, device="cpu", **kw)
sv = AutoModel(model="iic/SenseVoiceSmall", device="mps", **kw)
pf = AutoModel(model="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", device="mps", **kw)
for w in o.wavs:
    w = Path(w).expanduser()
    x, sr = sf.read(w, dtype="float32")
    assert sr == 16000 and x.ndim == 1, (w, sr, x.shape)
    t0 = time.time()
    segs = vad.generate(input=x)[0]["value"]
    res = {"sensevoice": [], "paraformer": []}
    for s, e in segs:
        a = x[int(s * 16):int(e * 16)]
        if len(a) < 1600:
            continue
        t1 = sv.generate(input=a, language="zh", use_itn=True)[0]["text"]
        import re
        t1 = re.sub(r"<\|[^|]*\|>", "", t1).strip()
        t2 = pf.generate(input=a)[0]["text"].strip()
        if t1:
            res["sensevoice"].append({"start": int(s), "end": int(e), "text": t1})
        if t2:
            res["paraformer"].append({"start": int(s), "end": int(e), "text": t2})
    for k, v in res.items():
        (out / k).mkdir(parents=True, exist_ok=True)
        (out / k / f"{w.stem}.json").write_text(json.dumps({"engine": k, "sents": v}, ensure_ascii=False))
    print(f"{w.stem}: {len(x) / sr / 60:.1f} 分钟，{len(segs)} 段，用时 {time.time() - t0:.0f}s", flush=True)
