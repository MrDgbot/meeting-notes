"""用产品自己的纪要流程（POST /api/meetings/<id>/minutes）给一场会生成纪要，结果存到评测目录，不碰真实数据。

  .venv/bin/python tests/eval/gen_minutes.py ~/eval-data/<会议目录> --provider local --label 本地 --out ~/eval-out/minutes
  .venv/bin/python tests/eval/gen_minutes.py ~/eval-data/<会议目录> --provider dashscope --label 百炼 --out ~/eval-out/minutes
  （云端 Key 用环境变量 DASHSCOPE_API_KEY / DEEPSEEK_API_KEY 传，不写进文件）

做法：临时数据目录里放这场会（转写稿、meta）和设置的副本，另起一个产品实例（端口自选），调纪要接口，读完流式结果后关掉。
--transcript 可以换成别的引擎的转写（run_pipeline 输出），用来比较“转写变好以后纪要变好多少”。
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--provider", required=True)
ap.add_argument("--label", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--transcript", help="换用别的转写：run_pipeline 输出目录")
ap.add_argument("--template", default="general")
o = ap.parse_args()
D = Path(o.dir).expanduser()
tmp = Path(tempfile.mkdtemp(prefix="mn-min-"))
mid = "eval-meeting"
md = tmp / "meetings" / mid
md.mkdir(parents=True)
meta = json.loads((D / "meta.json").read_text())
meta["id"] = mid
(md / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
if o.transcript:
    h = json.loads(next(Path(o.transcript).expanduser().glob("*.json")).read_text())
    (md / "transcript.json").write_text(json.dumps({"paragraphs": h["paras"]}, ensure_ascii=False))
else:
    shutil.copy(D / "transcript.json", md / "transcript.json")
shutil.copy(ROOT / "data/settings.json", tmp / "settings.json")
shutil.copy(ROOT / "data/vocab.json", tmp / "vocab.json")
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
env = {**os.environ, "MEETING_DATA": str(tmp), "PORT": str(port)}
srv = subprocess.Popen([str(ROOT / ".venv/bin/python"), "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                       cwd=ROOT, env=env, stdout=open(tmp / "server.log", "w"), stderr=subprocess.STDOUT)
try:
    for _ in range(120):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meetings", timeout=2)
            break
        except Exception:  # noqa: BLE001
            time.sleep(1)
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/meetings/{mid}/minutes", method="POST",
                                 data=json.dumps({"provider": o.provider, "template": o.template}).encode(),
                                 headers={"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}"})
    t = time.time()
    rec, err, status = None, None, []
    with urllib.request.urlopen(req, timeout=3600) as r:
        for line in r:
            ev = json.loads(line)
            if ev["type"] == "status":
                status.append(ev["msg"])
                print(ev["msg"], flush=True)
            elif ev["type"] == "done":
                rec = ev["minutes"]
            elif ev["type"] == "error":
                err = ev["msg"]
    out = Path(o.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    if rec is None:
        sys.exit(f"失败：{err}")
    rec.update(label=o.label, transcript=o.transcript or "产品当时的转写", wall_s=round(time.time() - t, 1), status=status)
    (out / f"{o.label}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1))
    (out / f"{o.label}.md").write_text(rec["markdown"])
    print(f"{o.label}：{len(rec['markdown'])} 字，{rec['wall_s']}s")
finally:
    srv.terminate()
    srv.wait(timeout=30)
    shutil.rmtree(tmp, ignore_errors=True)
