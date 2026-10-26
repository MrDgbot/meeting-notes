import json, os, re, sys, tempfile, unicodedata
from pathlib import Path
import soundfile as sf
os.environ["MEETING_DATA"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parents[3])); sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "audio"))
import asr_engine, cer
OUT = Path.home() / "eval-out/sep-probe"
norm = lambda s: re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).upper())
E = lambda r, h: sum(cer.edit_ops(r, h))
eng = asr_engine.Engine(); eng.ensure("nano")
meta = json.loads((OUT / "meta.json").read_text())
tot = mix_e = sep_e = add_e = 0
for m in meta:
    k = m["k"]; A, B = norm(m["refA"]), norm(m["refB"])
    h = {n: norm(eng._nano(sf.read(OUT / f"{k:02d}_{n}.wav", dtype="float32")[0])["text"]) for n in ("mix", "s0", "s1")}
    em = min(E(A + B, h["mix"]), E(B + A, h["mix"]))
    es = min(E(A, h["s0"]) + E(B, h["s1"]), E(A, h["s1"]) + E(B, h["s0"]))
    ea = min(E(X, h["mix"]) + E(Y, h[s]) for X, Y in ((A, B), (B, A)) for s in ("s0", "s1"))
    n = len(A) + len(B); tot += n; mix_e += em; sep_e += es; add_e += ea
    print(f"{k:02d} {n:3d}字 混合 {em / n:5.0%}  分离两路 {es / n:5.0%}  混合+补一路 {ea / n:5.0%} | A:{A[:14]} B:{B[:14]} | mix:{h['mix'][:16]} s0:{h['s0'][:12]} s1:{h['s1'][:12]}", flush=True)
print(f"\n合计 {tot} 字：只用混合音 {mix_e / tot:.1%}；两路都用分离音 {sep_e / tot:.1%}；混合音 + 补第二路（理想选择）{add_e / tot:.1%}")
