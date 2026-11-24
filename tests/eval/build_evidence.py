"""给每条陈述配证据窗口（docs/prereg-claims.md 第 3 节），按批写成裁判要读的文件。

  # 周会
  .venv/bin/python tests/eval/build_evidence.py weekly --claims ~/eval-out/claims/weekly/claims.json --out ~/eval-out/claims/weekly
  # AliMeeting 自证
  .venv/bin/python tests/eval/build_evidence.py ali --claims ~/eval-out/claims/ali/claims.json --out ~/eval-out/claims/ali

用仓库的 .venv 跑（产品当时的转写要套用 vocab.json 的纠错规则，和网页上看到的一致）。
陈述 JSON：[{id, text, time_hint, session?}]。输出：<out>/windows_<session>.json（全场窗口）、<out>/batches/b<NN>.md（每批 BATCH 条）。
"""
import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

H = Path.home()
ROOT = Path(__file__).resolve().parents[2]
WIN = 30_000
BATCH = 8


def load(p, key=None):
    p = Path(p).expanduser()
    if p.is_dir():
        p = next(p.glob("*.json"))
    d = json.loads(p.read_text())
    xs = d.get(key) if key else (d.get("sents") or d.get("paras") or d.get("paragraphs"))
    # Paraformer 原始输出是逐字加空格的，去掉中文字之间的空格
    return [{**x, "text": re.sub(r"(?<=[^\x00-\x7f]) +(?=[^\x00-\x7f])", "", x["text"])} for x in xs]


def engines_for(kind, session):
    """[(列名, 句子列表, 说话人前缀或 None)]，按厂商分组排列。"""
    E = []
    if kind == "weekly":
        os.environ.setdefault("MEETING_DATA", str(ROOT / "data"))
        sys.path.insert(0, str(ROOT))
        import vocab
        E.append(("飞书", load(H / "eval-out/weekly-1023-feishu/audio16k.json"), "飞书说话人"))
        E.append(("产品当时", vocab.apply_paras(load(H / "eval-data/weekly-1023/transcript.json")), "说话人"))
        E.append(("豆包重跑", load(H / "eval-out/weekly-1023-doubao/audio16k.json"), "豆包说话人"))
        E.append(("Nano", load(H / "eval-out/weekly-1023-nano/audio16k.json"), "Nano说话人"))
        name = "audio16k"
    else:
        E.append(("豆包", load(H / f"eval-out/ali-eval-doubao/{session}.json"), "豆包说话人"))
        E.append(("Nano", load(H / f"eval-out/ali-eval-nano/{session}.json"), "Nano说话人"))
        name = session
    for k, label in (("paraformer", "Paraformer"), ("sensevoice", "SenseVoice"), ("whisper", "Whisper")):
        p = H / f"eval-out/extra-asr/{k}/{name}.json"
        if p.exists():
            E.append((label, load(p), None))
    return E


def windows(E):
    end = max(x["end"] for _, xs, _ in E for x in xs)
    n = end // WIN + 1
    W = [{"i": i, "start": i * WIN, "end": (i + 1) * WIN, "cols": {}} for i in range(n)]
    for col, xs, pre in E:
        for x in sorted(xs, key=lambda x: x["start"]):
            s, e, t = x["start"], max(x["end"], x["start"] + 1), x["text"]
            # 跨窗的句子/段落按时间比例切开文字
            for i in range(s // WIN, min(n - 1, (e - 1) // WIN) + 1):
                a, b = max(s, i * WIN), min(e, (i + 1) * WIN)
                piece = t[round((a - s) / (e - s) * len(t)):round((b - s) / (e - s) * len(t))]
                if not piece:
                    continue
                spk = f"{pre}{x['spk'] + 1}" if pre and x.get("spk") is not None else None
                W[i]["cols"].setdefault(col, []).append((spk, piece))
    return W


def wtext(w):
    return "".join(p for v in w["cols"].values() for _, p in v)


def bigrams(s):
    s = re.sub(r"[\W_]+", "", s)
    return Counter(s[i:i + 2] for i in range(len(s) - 1))


def parse_hint(h):
    if not h:
        return None
    m = re.search(r"(\d+):(\d{2})(?::(\d{2}))?", str(h))
    if not m:
        return None
    a, b, c = m.groups()
    return ((int(a) * 3600 + int(b) * 60 + int(c)) if c else (int(a) * 60 + int(b))) * 1000


def render(w, cols):
    f = lambda ms: f"{ms // 3600000}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}"
    out = [f"[W{w['i']:04d} {f(w['start'])}–{f(w['end'])}]"]
    for col in cols:
        v = w["cols"].get(col)
        if not v:
            out.append(f"  {col}: （无）")
            continue
        segs, last = [], object()
        for spk, p in v:
            segs.append((f"（{spk}）" if spk and spk != last else "") + p)
            last = spk
        out.append(f"  {col}: " + "".join(segs))
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["weekly", "ali"])
    ap.add_argument("--claims", required=True)
    ap.add_argument("--out", required=True)
    o = ap.parse_args()
    out = Path(o.out).expanduser()
    (out / "batches").mkdir(parents=True, exist_ok=True)
    claims = json.loads(Path(o.claims).expanduser().read_text())
    cache, ev = {}, {}
    for c in claims:
        ses = c.get("session") or "weekly"
        if ses not in cache:
            E = engines_for(o.kind, ses)
            W = windows(E)
            df = Counter(g for w in W for g in bigrams(wtext(w)))
            cache[ses] = (E, W, df, [bigrams(wtext(w)) for w in W])
            (out / f"windows_{ses}.json").write_text(json.dumps([{"i": w["i"], "start": w["start"], "end": w["end"], "cols": w["cols"]} for w in W], ensure_ascii=False))
        E, W, df, BG = cache[ses]
        q = bigrams(c["text"])
        idf = {g: math.log(len(W) / (1 + df.get(g, 0))) for g in q}
        score = [sum(idf[g] * min(1, bg.get(g, 0)) for g in q) for bg in BG]
        top = sorted(range(len(W)), key=lambda i: -score[i])[:5]
        t = parse_hint(c.get("time_hint"))
        near = [i for i in range(len(W)) if t is not None and abs(W[i]["start"] + WIN // 2 - t) <= 90_000]
        # 时间点附近的窗按离时间点的远近排，最多 4 个；再补检索结果，合计最多 8 个
        near = sorted(near, key=lambda i: abs(W[i]["start"] + WIN // 2 - t))[:4]
        pick = sorted(set(near) | set(top[: 8 - len(near)]))
        ev[c["id"]] = pick
    (out / "evidence_index.json").write_text(json.dumps(ev, ensure_ascii=False))
    for b in range(0, len(claims), BATCH):
        parts = []
        for c in claims[b:b + BATCH]:
            ses = c.get("session") or "weekly"
            E, W, _, _ = cache[ses]
            cols = [col for col, _, _ in E]
            parts.append(f"## 陈述 {c['id']}\n{c['text']}\n（纪要给出的时间点：{c.get('time_hint') or '无'}）\n\n### 证据窗口\n" +
                         "\n\n".join(render(W[i], cols) for i in ev[c["id"]]))
        (out / "batches" / f"b{b // BATCH:02d}.md").write_text("\n\n---\n\n".join(parts) + "\n")
    print(f"{len(claims)} 条陈述，{math.ceil(len(claims) / BATCH)} 批；每条平均 {sum(map(len, ev.values())) / len(ev):.1f} 个窗口；"
          f"引擎：{ {s: [e[0] for e in v[0]] for s, v in cache.items()} }")


if __name__ == "__main__":
    main()
