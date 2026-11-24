"""用人工校对的 6 段（gold/clips.json）给真实会议上的几种转写打分。

  tests/eval/.venv/bin/python tests/eval/score_weekly.py ~/eval-data/weekly-1023 \
      --hyp 产品当时=~/eval-data/weekly-1023/transcript.json --hyp 豆包=~/eval-out/weekly-1023-doubao --hyp Nano=~/eval-out/weekly-1023-nano

每段按会议时间截取识别结果（取中点落在片段内的句子），和人工文字逐字比较（规范化同 score.py）。
- CER：sclite、jiwer 两套实现，对不上就报错。
- 业务词召回：词表（vocab.json 的纠错目标 + 热词 + 片段目录下 glossary.txt，一行一个）里的词，人工文字里出现几次、识别结果里对上几次。
- 谁说了什么（cpCER）：人工标的说话人 vs 识别结果的说话人编号，MeetEval cpWER 按字算。
- 说话人编号是不是真的人：gold/speakers.json 里每个编号对应的名字。
产品当时：网页上看到的样子（转写稿 + 纠错规则）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import jiwer

ROOT = Path(__file__).resolve().parents[2]
SCLITE = Path.home() / "tools/SCTK/bin/sclite"


def norm(s):
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).upper())


def load_hyp(p: Path):
    if p.is_dir():
        d = json.loads(next(p.glob("*.json")).read_text())
        return d.get("sents") or d["paras"], False
    return json.loads(p.read_text())["paragraphs"], True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--hyp", action="append", required=True, help="名字=路径（run_pipeline 输出目录，或 transcript.json）")
    ap.add_argument("--partial", action="store_true", help="没勾“已改好”的片段也算（只用来看进度，不当结论）")
    o = ap.parse_args()
    D = Path(o.dir).expanduser()
    man = json.loads((D / "manifest.json").read_text())
    gold = json.loads((D / "gold/clips.json").read_text())
    os.environ.setdefault("MEETING_DATA", str(ROOT / "data"))
    sys.path.insert(0, str(ROOT))
    import vocab  # noqa: E402  只读 vocab.json
    v = vocab.get()
    terms = {f["to"] for f in v.get("fixes", [])} | set(vocab.split_words(v.get("hotwords", "")))
    if (D / "glossary.txt").exists():
        terms |= {t.strip() for t in (D / "glossary.txt").read_text().splitlines() if t.strip()}
    terms = sorted({norm(t) for t in terms if norm(t)}, key=len, reverse=True)
    clips = [c for c in man["clips"] if c["id"] in gold and (gold[c["id"]].get("done") or o.partial)]
    if not clips:
        sys.exit("还没有校对完成的片段")
    out = {"clips": [c["id"] for c in clips], "terms": terms, "systems": {}}
    for spec in o.hyp:
        name, path = spec.split("=", 1)
        items, is_product = load_hyp(Path(path).expanduser())
        if is_product:
            items = vocab.apply_paras(items)
        tot = {"S": 0, "D": 0, "I": 0, "N": 0, "term_ref": 0, "term_hit": 0}
        per, ref_trn, hyp_trn, ref_stm, hyp_stm = [], [], [], [], []
        for c in clips:
            rows = gold[c["id"]]["rows"]
            ref = norm("".join(r["text"] for r in rows))
            sel = sorted([x for x in items if c["start"] <= (x["start"] + x["end"]) / 2 < c["end"]], key=lambda x: (x["start"], x["end"]))
            hyp = norm("".join(x["text"] for x in sel))
            m = jiwer.process_characters(ref, hyp)
            tr = sum(ref.count(t) for t in terms)
            th = sum(min(ref.count(t), hyp.count(t)) for t in terms)
            per.append({"clip": c["id"], "code": c["code"], "label": c["label"], "ref_chars": len(ref),
                        "cer": (m.substitutions + m.deletions + m.insertions) / max(1, len(ref)),
                        "sub": m.substitutions, "del": m.deletions, "ins": m.insertions, "terms": f"{th}/{tr}"})
            for k, val in (("S", m.substitutions), ("D", m.deletions), ("I", m.insertions), ("N", len(ref)), ("term_ref", tr), ("term_hit", th)):
                tot[k] += val
            ref_trn.append(f"{' '.join(ref)} ({c['id']})")
            hyp_trn.append(f"{' '.join(hyp)} ({c['id']})")
            for r in rows:
                t = norm(r["text"])
                if t:
                    ref_stm.append(f"{c['id']} 1 {r['spk'] or '未标'} {(c['start'] + r['start']) / 1000:.2f} {(c['start'] + r['end']) / 1000:.2f} {' '.join(t)}")
            for x in sel:
                t = norm(x["text"])
                if t:
                    hyp_stm.append(f"{c['id']} 1 spk{x.get('spk', 0)} {x['start'] / 1000:.2f} {x['end'] / 1000:.2f} {' '.join(t)}")
        wd = D / "score" / name
        wd.mkdir(parents=True, exist_ok=True)
        for fn, lines in (("ref.trn", ref_trn), ("hyp.trn", hyp_trn), ("ref.stm", ref_stm), ("hyp.stm", hyp_stm)):
            (wd / fn).write_text("\n".join(lines) + "\n", encoding="utf-8")
        sc = subprocess.run([str(SCLITE), "-r", str(wd / "ref.trn"), "trn", "-h", str(wd / "hyp.trn"), "trn", "-i", "rm", "-o", "dtl", "stdout"],
                            capture_output=True, text=True).stdout
        mt = re.search(r"Percent Total Error\s*=\s*([\d.]+)%\s*\(\s*(\d+)\)", sc)
        errs = tot["S"] + tot["D"] + tot["I"]
        # sclite 默认按加权代价对齐（替换 4、增删 3），个别地方会比纯编辑距离多数一两个错；超过参考字数的 0.1% 才算不一致
        if not mt or abs(int(mt.group(2)) - errs) > max(1, tot["N"] // 1000):
            print(f"!! {name}: sclite 和 jiwer 不一致：{mt and mt.group(2)} vs {errs}")
        subprocess.run([str(Path(sys.executable).parent / "meeteval-wer"), "cpwer", "-r", str(wd / "ref.stm"), "-h", str(wd / "hyp.stm"),
                        "--average-out", str(wd / "cpcer.json"), "--per-reco-out", str(wd / "cpcer_per.json")], capture_output=True)
        cp = json.loads((wd / "cpcer.json").read_text())["error_rate"] if (wd / "cpcer.json").exists() else None
        cp_per = json.loads((wd / "cpcer_per.json").read_text()) if (wd / "cpcer_per.json").exists() else {}
        for p in per:
            p["cpcer"] = (cp_per.get(p["clip"]) or {}).get("error_rate")
        out["systems"][name] = {"cer": errs / tot["N"], "sclite_errors": mt and int(mt.group(2)), "errors": errs, "ref_chars": tot["N"],
                                "term_recall": f"{tot['term_hit']}/{tot['term_ref']}", "cpcer": cp, "per_clip": per}
    sp = D / "gold/speakers.json"
    if sp.exists():
        s = json.loads(sp.read_text())
        names = {k: (x.get("name") or "").strip() for k, x in s.items() if not x.get("unknown") and (x.get("name") or "").strip()}
        out["speakers"] = {"ids": len(man["samples"]), "named": len(names), "people": len(set(names.values())),
                           "same_person": {n: [k for k in names if names[k] == n] for n in set(names.values()) if list(names.values()).count(n) > 1},
                           "unknown": [k for k, x in s.items() if x.get("unknown")]}
    (D / "score/summary.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for name, r in out["systems"].items():
        print(f"{name}: CER {r['cer'] * 100:.2f}%（{r['errors']}/{r['ref_chars']}）业务词 {r['term_recall']}  cpCER {r['cpcer'] if r['cpcer'] is None else round(r['cpcer'] * 100, 2)}%")
        for p in r["per_clip"]:
            print(f"   {p['clip']} {p['code']} {p['label']}: CER {p['cer'] * 100:.1f}%  业务词 {p['terms']}  cpCER {p['cpcer']}")
    if "speakers" in out:
        print("说话人：", out["speakers"])


if __name__ == "__main__":
    main()
