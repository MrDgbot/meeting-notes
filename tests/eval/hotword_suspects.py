"""疑似认错的热词（vocab.suspects）：在一场有参考的会上看找得对不对，在 AliMeeting 上看误报多不多。

  .venv/bin/python tests/eval/hotword_suspects.py [会议的 transcript.json]
AliMeeting 里没有这些业务词，报出来的都算误报。用的是已有的 Nano 转写（final-test-campp、r1-eval-all），不重新识别。
"""
import glob
import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-hw-"))  # 空词库：只用下面给的热词
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import vocab  # noqa: E402

HW = ("长尾词 以图搜图 竞品分析 供应链 利润率 转化率 关键词 亚马逊 新品上架 预算池 差评分类 打标系统 底座数据 项目管理 "
      "销量预测 促销活动 广告投放 用户画像 市场调研 品牌定位")
H = Path.home()
if len(sys.argv) > 1:
    ps = json.loads(Path(sys.argv[1]).read_text())["paragraphs"]
    t = time.time()
    s = vocab.suspects(ps, HW)
    print(f"这场会（{len(ps)} 段，{time.time() - t:.1f} 秒）：", [(x["text"], "→", x["hotword"], x["count"]) for x in s])
n, hours, bad = 0, 0.0, []
for f in glob.glob(str(H / "eval-out/final-test-campp/*.json")) + glob.glob(str(H / "eval-out/r1-eval-all/*.json")):
    j = json.loads(Path(f).read_text())
    hours += j.get("duration_s", 0) / 3600
    n += 1
    bad += vocab.suspects(j.get("paras") or j["sents"], HW)
print(f"AliMeeting {n} 场 {hours:.1f} 小时，20 个热词：误报 {sum(b['count'] for b in bad)} 处 {[(b['text'], b['hotword']) for b in bad]}")
