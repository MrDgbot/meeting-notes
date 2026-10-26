"""留出集汇总：字错率（按人数分组）、DER、cpCER、人数（照 spk_score 的数法：过一遍 _speaker_units 再数），和基线并排。

  .venv/bin/python tests/eval/final_summary.py --split test --runs ~/eval-out/final-test-campp ~/eval-out/final-test-pyannote
基线：~/eval-out/ali-test-nano（上一轮的转写）+ spk-sweep 里 D5 方案的说话人时间段，离线重建段落（不拆句）后算 cpCER 和人数。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-eval-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import asr_engine  # noqa: E402
import split_sweep as S  # noqa: E402

E = asr_engine.Engine
H = Path.home()


def count(segs, turns):
    return len({u[2] for u in E._speaker_units([list(s) for s in segs], [tuple(t) for t in turns])}) if turns else 1


def cpcer(ref_stm: Path, paras_by_s: dict) -> float:
    d = Path(tempfile.mkdtemp())
    lines = [f"{s} 1 spk{p['spk']} {p['start'] / 1000:.2f} {p['end'] / 1000:.2f} {' '.join(S.norm(p['text']))}"
             for s, ps in paras_by_s.items() for p in ps if S.norm(p["text"])]
    (d / "h.stm").write_text("\n".join(lines) + "\n", encoding="utf-8")
    subprocess.run([str(S.MEETEVAL), "cpwer", "-r", str(ref_stm), "-h", str(d / "h.stm"), "--average-out", str(d / "c.json")],
                   capture_output=True, check=True)
    return json.loads((d / "c.json").read_text())["error_rate"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="test")
    ap.add_argument("--runs", nargs="+", required=True)
    ap.add_argument("--base", default=str(H / "eval-out/ali-test-nano"))
    ap.add_argument("--base-turns", default=str(H / "eval-out/spk-sweep/nassign_m30_t0.72_s0"))
    o = ap.parse_args()
    ref = H / f"eval-data/ali-{o.split}/ref"
    rows = {}
    # 基线
    base, bt = Path(o.base), Path(o.base_turns)
    sess = sorted(p.stem for p in base.glob("*.json"))
    paras, ok, err = {}, 0, []
    for s in sess:
        h = json.loads((base / f"{s}.json").read_text())
        T = S.read_turns(bt / f"{s}.rttm")
        paras[s] = E._paragraphs(E._assign_speakers([dict(x) for x in h["sents"]], T, 0))
        n, nr = count(h["vad_segs"], T), len(S.read_turns(ref / f"{s}.rttm") and {l.split()[7] for l in (ref / f"{s}.rttm").read_text().splitlines()})
        ok += n == nr; err.append(abs(n - nr))
    sc = json.loads((Path(str(base) + "-score") / "summary.json").read_text())
    rows["基线（上一版）"] = (sc, cpcer(Path(str(base) + "-score") / "ref.stm", paras), ok, sum(err) / len(err))
    for r in map(Path, o.runs):
        sc = json.loads((Path(str(r) + "-score") / "summary.json").read_text())
        ok, err = 0, []
        for s in sess:
            h = json.loads((r / f"{s}.json").read_text())
            nr = len({l.split()[7] for l in (ref / f"{s}.rttm").read_text().splitlines()})
            n = count(h["vad_segs"], h["turns"]); ok += n == nr; err.append(abs(n - nr))
        rows[r.name] = (sc, sc["overall"]["cpcer"], ok, sum(err) / len(err))
    print(f"{'':22}{'总字错率':>8}{'2人':>8}{'3人':>8}{'4人':>8}{'DER c0.25':>10}{'DER c0':>8}{'cpCER':>8}{'人数判对':>8}{'人数误差':>8}{'耗时/时长':>9}")
    for name, (sc, cp, ok, mae) in rows.items():
        per = sc["per_session"]
        def g(n):
            rs = [x for x in per if x["ref_spk"] == n]; t = sum(x["ref_chars"] for x in rs)
            return sum(x["sub"] + x["del"] + x["ins"] for x in rs) / t
        o_ = sc["overall"]; rtf = sum(x["rtf"] * x["min"] for x in per) / sum(x["min"] for x in per)
        print(f"{name:22}{o_['cer_jiwer']:>9.2%}{g(2):>8.2%}{g(3):>8.2%}{g(4):>8.2%}{o_['der_pyannote_c0.25']:>10.2%}{o_['der_pyannote_c0.0']:>8.2%}{cp:>8.2%}{ok:>6}/{len(per)}{mae:>8.2f}{rtf:>9.3f}")


if __name__ == "__main__":
    main()
