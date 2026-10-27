"""会后转写的速度：指定一份代码（目录），用它的 Engine.transcribe（默认 Fun-ASR-Nano + CAM++）依次转写几个录音，记下耗时。
先拿第一个录音的前 60 秒热身一次（MPS 第一次跑要编译），不计时。机器上不要同时跑别的任务。

  .venv/bin/python tests/eval/speed_bench.py --code <代码目录> --out 结果.json <wav...>
"""
import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--code", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("wavs", nargs="+")
o = ap.parse_args()
tmp = Path(tempfile.mkdtemp(prefix="mn-speed-"))
(tmp / "meetings").mkdir()
(tmp / "settings.json").write_text(json.dumps({"asr": {"model": "nano", "diarizer": "campp"}}))
os.environ["MEETING_DATA"] = str(tmp)
sys.path.insert(0, str(Path(o.code).expanduser().resolve()))
import soundfile as sf  # noqa: E402

import asr_engine  # noqa: E402

assert Path(asr_engine.__file__).resolve().parent == Path(o.code).expanduser().resolve(), asr_engine.__file__
e = asr_engine.Engine()
t = time.time()
e.load()
assert e.ready and e.nano is not None, (e.error, getattr(e, "nano_error", ""))
load_s = time.time() - t
x, sr = sf.read(o.wavs[0], dtype="float32")
sf.write(tmp / "warm.wav", x[: sr * 60], sr)
e.transcribe(tmp / "warm.wav", 0, "", None)
rows = []
for w in o.wavs:
    dur = sf.info(w).duration
    t = time.time()
    ps = e.transcribe(Path(w), 0, "", None)
    cost = time.time() - t
    rows.append({"wav": Path(w).stem, "min": round(dur / 60, 1), "cost_s": round(cost, 1), "rtf": round(cost / dur, 4),
                 "paras": len(ps), "spk": len({p["spk"] for p in ps})})
    print(rows[-1], flush=True)
Path(o.out).write_text(json.dumps({"code": str(o.code), "device": asr_engine.DEVICE, "load_s": round(load_s, 1), "rows": rows}, ensure_ascii=False, indent=1))
