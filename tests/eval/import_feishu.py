"""把飞书妙记的逐字稿转成和 run_pipeline 输出一样的格式，供 score_weekly.py 打分。

  python3 tests/eval/import_feishu.py ~/eval-out/weekly-1023-feishu

输入：<目录>/raw/subtitles_v2.json、<目录>/raw/speakers.json。这两个文件是妙记网页自己调用的接口返回的原样内容：
  GET /minutes/api/subtitles_v2?object_token=..&paragraph_id=<第一段 pid>&size=300&language=zh_cn（全部段落，带逐词时间）
  GET /minutes/api/speakers?object_token=..&language=zh_cn&size=10000（每段的说话人）
输出：<目录>/audio16k.json，含 sents（妙记的句子：时间、文字、说话人）和 paras（妙记的段落）。
说话人编号：妙记的“说话人 N”记成 N-1。
"""
import json
import sys
from pathlib import Path

D = Path(sys.argv[1]).expanduser()
sub = json.loads((D / "raw/subtitles_v2.json").read_text())["data"]
spk = json.loads((D / "raw/speakers.json").read_text())["data"]
assert not sub["has_more"] and len(sub["paragraphs"]) == sub["total"], "逐字稿没取全"
assert not spk["has_more"] and len(spk["paragraph_to_speaker"]) == spk["total"] == sub["total"], "说话人没取全"
p2s = spk["paragraph_to_speaker"]
sents, paras = [], []
for p in sub["paragraphs"]:
    s = int(p2s[p["pid"]]) - 1
    texts = []
    for x in p["sentences"]:
        t = "".join(c["content"] for c in x["contents"])
        texts.append(t)
        sents.append({"start": int(x["start_time"]), "end": int(x["stop_time"]), "text": t, "spk": s})
    paras.append({"start": int(p["start_time"]), "end": int(p["stop_time"]), "text": "".join(texts), "spk": s})
out = {"engine": "feishu-minutes", "paras": paras, "sents": sents}
(D / "audio16k.json").write_text(json.dumps(out, ensure_ascii=False))
print(f"{len(paras)} 段，{len(sents)} 句，{len({p['spk'] for p in paras})} 个说话人，到 {paras[-1]['end'] / 60000:.1f} 分钟，{sum(len(p['text']) for p in paras)} 字")
