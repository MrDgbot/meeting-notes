"""字错率（CER）：拿人工校对过的标准文本，和某场会议在同一时间段的转写比。
同一段话 Mac 录一份、iPhone 录一份，各算一次，就能比较手机录音的识别质量（验收线：手机不比 Mac 高 3 个百分点以上）。

用法：
  .venv/bin/python tests/audio/cer.py 标准文本.txt <会议ID> --from 10:00 --to 12:00 [--source transcript|live] [--data data]
标准文本里的标点、空格、换行都会被忽略；时间是这场录音里的位置（转写稿上显示的时间戳）。
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).lower()
    return re.sub(r"[\W_]+", "", s)  # 去掉标点、空白（保留汉字、字母、数字）


def edit_ops(ref: str, hyp: str) -> tuple[int, int, int]:
    """替换、删除、插入的个数（Levenshtein，两行滚动）。"""
    prev = [(j, 0, 0, j) for j in range(len(hyp) + 1)]  # (距离, 替换, 删除, 插入)
    for i in range(1, len(ref) + 1):
        cur = [(i, 0, i, 0)]
        for j in range(1, len(hyp) + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur.append(prev[j - 1])
                continue
            s, d, ins = prev[j - 1], prev[j], cur[j - 1]
            best = min((s[0], 0), (d[0], 1), (ins[0], 2))
            if best[1] == 0:
                cur.append((s[0] + 1, s[1] + 1, s[2], s[3]))
            elif best[1] == 1:
                cur.append((d[0] + 1, d[1], d[2] + 1, d[3]))
            else:
                cur.append((ins[0] + 1, ins[1], ins[2], ins[3] + 1))
        prev = cur
    return prev[-1][1], prev[-1][2], prev[-1][3]


def ts(v: str) -> int:
    parts = [float(x) for x in v.split(":")]
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return int(sec * 1000)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref")
    ap.add_argument("mid")
    ap.add_argument("--from", dest="a", default="0")
    ap.add_argument("--to", dest="b", default="999:00:00")
    ap.add_argument("--source", choices=["transcript", "live"], default="transcript")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parents[2] / "data"))
    o = ap.parse_args()
    d = Path(o.data) / "meetings" / o.mid
    paras = json.loads((d / "transcript.json").read_text())["paragraphs"] if o.source == "transcript" else json.loads((d / "live.json").read_text())
    a, b = ts(o.a), ts(o.b)
    hyp = "".join(p["text"] for p in paras if p["end"] > a and p["start"] < b)
    ref = Path(o.ref).read_text(encoding="utf-8")
    r, h = norm(ref), norm(hyp)
    if not r:
        sys.exit("标准文本是空的")
    s, dl, ins = edit_ops(r, h)
    print(f"标准 {len(r)} 字，识别 {len(h)} 字：替换 {s}，漏字 {dl}，多字 {ins}")
    print(f"CER = {(s + dl + ins) / len(r) * 100:.2f}%")


if __name__ == "__main__":
    main()
