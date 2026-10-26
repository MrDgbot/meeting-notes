"""用产品自己的会后转写代码（asr_engine.Engine.transcribe）跑一批 wav，存下段落和说话人分离结果。

在 app 的环境里跑（要 import asr_engine）：
  .venv/bin/python tests/eval/run_pipeline.py --engine nano --out ~/eval-out/ali-test-nano ~/eval-data/ali-test/wav/*.wav
  --engine：hanbao（憨包识别 + 本机说话人）、nano（Fun-ASR-Nano）、paraformer
输出每个文件一个 JSON：paras（网页上看到的段落）、turns（声纹聚类得到的说话人时间段，用来算 DER）、耗时。
设置写在临时数据目录里，不碰真实数据。已有结果的文件跳过，可以中断后接着跑。
"""
import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("wavs", nargs="+")
ap.add_argument("--engine", choices=["hanbao", "nano", "paraformer"], required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--num-spk", type=int, default=0, help="0 = 自动判断（产品默认）")
ap.add_argument("--vad-thres", type=float, default=None, help="全天模式的收音灵敏度（speech_noise_thres）；不给 = 手动录音的默认")
ap.add_argument("--hotword", default="")
o = ap.parse_args()

tmp = Path(tempfile.mkdtemp(prefix="mn-eval-"))
(tmp / "meetings").mkdir()
(tmp / "settings.json").write_text(json.dumps({"asr": {"model": o.engine}}))
os.environ["MEETING_DATA"] = str(tmp)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import asr_engine  # noqa: E402

out = Path(o.out).expanduser()
out.mkdir(parents=True, exist_ok=True)
eng = asr_engine.Engine()
captured: dict = {}
_orig = eng._diarize


def _diarize(x, segs, num_spk=0):
    turns = _orig(x, segs, num_spk)
    captured["turns"] = turns
    captured["segs"] = [list(map(int, s)) for s in segs]
    return turns


eng._diarize = _diarize
_orig_paras = eng._paragraphs


def _paragraphs(sents):
    captured["sents"] = [dict(x) for x in sents]  # 合并成段落之前的句子（Nano 是小句，憨包是识别单元）：按时间截取片段时用
    return _orig_paras(sents)


eng._paragraphs = _paragraphs
t = time.time()
eng.load()
if not eng.ready:
    sys.exit(f"模型加载失败：{eng.error}")
print(f"模型就绪 {time.time() - t:.0f}s，引擎 {o.engine}", flush=True)
vad_kw = {"speech_noise_thres": o.vad_thres} if o.vad_thres is not None else None
for w in map(Path, o.wavs):
    dst = out / f"{w.stem}.json"
    if dst.exists():
        continue
    captured.clear()
    t = time.time()
    paras = eng.transcribe(w, o.num_spk, o.hotword, vad_kw)
    cost = time.time() - t
    dur = asr_engine.duration_of(w)
    dst.write_text(json.dumps({"file": w.name, "engine": o.engine, "info": eng.last_info, "duration_s": dur,
                               "cost_s": round(cost, 1), "paras": paras, "turns": captured.get("turns", []),
                               "vad_segs": captured.get("segs", []), "sents": captured.get("sents", [])}, ensure_ascii=False))
    print(f"{w.stem}: {dur / 60:.1f} 分钟，用时 {cost:.0f}s，{len(paras)} 段，{len({p['spk'] for p in paras})} 人，{eng.last_info}", flush=True)
