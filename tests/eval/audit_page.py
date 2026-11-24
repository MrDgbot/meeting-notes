"""审计页：每条“不是一致有依据”的陈述，加上随机抽的 20 条“一致有依据”，附原声片段和各引擎原文，任何人可以复听复核。

  python3 tests/eval/audit_page.py   → ~/eval-out/claims/weekly/audit/index.html（直接用浏览器打开）

原声：从冻结副本 ~/eval-data/weekly-1023/audio.mp3 按裁判引用的窗口切（前后各多 3 秒），切不出就用检索到的第一个窗口。
"""
import html
import json
import random
import re
import subprocess
from pathlib import Path

H = Path.home()
D = H / "eval-out/claims/weekly"
A = D / "audit"
(A / "clips").mkdir(parents=True, exist_ok=True)
M = json.loads((D / "merged.json").read_text())
EV = json.loads((D / "evidence_index.json").read_text())
W = json.loads((D / "windows_weekly.json").read_text())
ATTR = json.loads((D / "attr_merged.json").read_text()) if (D / "attr_merged.json").exists() else {}
rows = M["rows"]
sup = [r for r in rows if r["merged"] == "有依据"]
pick = [r for r in rows if r["merged"] != "有依据"] + random.Random(20261026).sample(sup, min(20, len(sup)))
cols = ["飞书", "产品当时", "豆包重跑", "Nano", "Paraformer", "SenseVoice"]
f = lambda ms: f"{ms // 3600000}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}"
BAD = {"与原话矛盾", "找不到依据", "张冠李戴"}
must = [r for r in rows if r["src"] == "M1" and r["merged"] in BAD and r["sev_strict"]]
must_ids = {r["id"] for r in must}
TERM = {"找不到依据": "原话里找不到这件事", "与原话矛盾": "和原话说的不一样", "张冠李戴": "人搞错了", "判不了": "录音听不清，裁判判不了",
        "裁判分歧": "两个裁判意见不一致", "有依据": "原话里有，裁判认为没错"}


SIL = A / "silences.json"  # 整段录音的停顿（-35 dB、≥0.35 秒），用来把切点挪到停顿上，不在半句话中间切
if not SIL.exists():
    log = subprocess.run(["ffmpeg", "-v", "info", "-i", str(H / "eval-data/weekly-1023/audio16k.wav"), "-af", "silencedetect=noise=-35dB:d=0.35",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    st = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", log)]
    en = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", log)]
    SIL.write_text(json.dumps([[a_, b_] for a_, b_ in zip(st, en)]))
PAUSES = json.loads(SIL.read_text())


def snap(sec, side, reach=12.0):
    """把切点挪到最近的停顿中间：开头往前找，结尾往后找；优先 ≥0.6 秒的停顿（多半是句子之间）。"""
    for mn, reach in ((0.6, reach), (0.35, reach), (0.35, reach * 2)):  # 附近找不到停顿就再往外找一倍
        c = [(a_ + b_) / 2 for a_, b_ in PAUSES if b_ - a_ >= mn and (sec - reach <= (a_ + b_) / 2 <= sec if side == "start" else sec <= (a_ + b_) / 2 <= sec + reach)]
        if c:
            return max(c) if side == "start" else min(c)
    return max(0.0, sec - 3) if side == "start" else sec + 3


def cut(dst, s_sec, e_sec):
    s_sec, e_sec = snap(s_sec, "start"), snap(e_sec, "end")
    if not dst.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{s_sec:.2f}", "-to", f"{e_sec:.2f}", "-i", str(H / "eval-data/weekly-1023/audio.mp3"),
                        "-ac", "1", "-b:a", "64k", "-af", "afade=t=in:d=0.15", str(dst)], check=True)
    return int(s_sec * 1000), int(e_sec * 1000)


def card(r, simple):
    wi = [int(w[1:]) for w in r["windows"] if w[1:].isdigit() and int(w[1:]) < len(W)] or EV[r["id"]][:1]
    s, e = min(W[i]["start"] for i in wi), max(W[i]["end"] for i in wi)
    if e - s > 120_000:  # 裁判引用的窗口相隔很远时，只切第一个
        s, e = W[wi[0]]["start"], W[wi[0]]["end"]
    s, e = cut(A / "clips" / f"{r['id']}.mp3", s / 1000, e / 1000)
    extra = ""  # 纪要标的时间点不在裁判引用的片段里时，再切一段那附近的原声
    for n, t in enumerate(re.findall(r"(?:(\d+):)?(\d{1,2}):(\d{2})", str(r.get("time_hint") or ""))[:2]):
        sec = int(t[0] or 0) * 3600 + int(t[1]) * 60 + int(t[2])
        if s / 1000 <= sec <= e / 1000:
            continue
        c2 = A / "clips" / f"{r['id']}_t{n}.mp3"
        s2, e2 = cut(c2, max(0, sec - 10), sec + 50)
        extra += f'<p>纪要标的时间点附近 {f(s2)}–{f(e2)}：<audio controls preload="none" src="clips/{c2.name}"></audio></p>'
    ev = "".join(f"<tr><td>{c}</td><td>{html.escape(''.join(((f'（{k}）' if k else '') + t) for k, t in W[i]['cols'].get(c, [])) or '（无）')}</td></tr>"
                 for i in wi for c in cols)
    at = ATTR.get(r["id"], {})
    who = "我们的纪要" if r["src"] == "M1" else "飞书纪要"
    pre = e <= 869574 + 1000  # 16:00 在录音里是 0:14:29；之前是会前的零散讨论（全天模式录进来的）
    tag = '<span class="pre">会前（16:00 之前）</span>' if pre else ""
    reasons = "".join(f'<li><b>{"裁判甲" if k == "claude" else "裁判乙"}</b>：{html.escape(str(v))}</li>' for k, v in r["reason"].items())
    btn = (f'<div class="ask">听完原声，你觉得{who}这句话：'
           f'<button data-v="纪要错了">确实写错了</button><button data-v="纪要没错">其实没错</button><button data-v="不是周会内容">不是周会的内容</button><button data-v="听不清">听不清/说不好</button>'
           f'<input placeholder="可选：补一句你听到的原话" class="note"><span class="saved"></span></div>')
    meta = f'{r["id"]} · {who} · {html.escape(r["type"])} · 裁判结论：<b>{html.escape(TERM.get(r["merged"], r["merged"]))}</b>' + (
        "" if simple else f' · 后果 {html.escape(r["sa"])}/{html.escape(r["sb"])}' + (f' · 环节 {html.escape(at.get("stage", ""))}' if at else ""))
    return f"""<section id="{r['id']}" data-id="{r['id']}" class="{'bad' if r['merged'] != '有依据' else 'ok'}"><h3>{tag}{meta}</h3>
<p class="claim">{who}里写的：「{html.escape(r['text'])}」<small>（纪要标的时间 {html.escape(str(r.get('time_hint') or '无'))}）</small></p>
<p>裁判引用的原声 {f(s)}–{f(e)}：<audio controls preload="none" src="clips/{r['id']}.mp3"></audio></p>{extra}
<ul>{reasons}</ul>{btn}
<details><summary>看各家转写原文（{len(wi)} 段，一般不用看）</summary><table>{ev}</table></details></section>"""


rest = [r for r in pick if r["id"] not in must_ids]
page = f"""<!doctype html><meta charset="utf-8"><title>10-23 周会纪要核对 · 请你听 {len(must)} 条</title>
<style>body{{font:15px/1.65 -apple-system,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#222}}
.guide{{background:#f5f7fa;border:1px solid #dde3ea;border-radius:10px;padding:14px 18px}} .guide ol{{margin:6px 0 0 1.2em;padding:0}}
section{{border-top:1px solid #e5e5e5;padding:12px 0}} h3{{font-size:13px;margin:2px 0;color:#555;font-weight:500}} .bad h3 b{{color:#b42318}} .ok h3 b{{color:#067647}}
.claim{{font-size:16px;margin:6px 0}} audio{{vertical-align:middle;height:34px}} ul{{margin:4px 0;color:#444;font-size:14px}}
.ask{{margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}} .ask button{{font:inherit;padding:4px 12px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}}
.ask button.on{{background:#1f6feb;color:#fff;border-color:#1f6feb}} .note{{flex:1;min-width:200px;font:inherit;padding:4px 8px;border:1px solid #ddd;border-radius:6px}}
.saved{{color:#067647;font-size:13px}} .pre{{background:#fff4e5;color:#b54708;border:1px solid #f5c58a;border-radius:4px;padding:0 6px;margin-right:6px;font-size:12px}} details{{font-size:13px;color:#555}} table{{border-collapse:collapse;font-size:12px}} td{{border:1px solid #eee;padding:2px 6px;vertical-align:top}}
td:first-child{{white-space:nowrap;color:#666}} #prog{{font-weight:600}} details.rest>summary{{font-size:15px;cursor:pointer;margin:24px 0 8px}}</style>
<h1>10-23 周会纪要核对</h1>
<div class="guide"><b>你只需要做一件事，大约 5 分钟。</b>两个 AI 裁判认为，我们的纪要里有下面 {len(must)} 句写错了，而且错得严重：期限、数字或负责人不对。请你帮忙听原声确认。
<ol><li>点 ▶ 听这一段原声，每段 30–60 秒，拖动进度条也可以；</li>
<li>对照“纪要里写的”那句话，点<b>确实写错了</b>、<b>其实没错</b>、<b>不是周会的内容</b>或<b>听不清</b>；标了“会前”的是 16:00 之前的零散讨论，录音本来就断断续续；</li>
<li>点完会自动保存，不用提交。全部点完告诉我一声就行。</li></ol>
进度：<span id="prog">0/{len(must)}</span>　<small>你点的结果只用来检查裁判准不准，不会改动纪要。</small></div>
<h2>请你听的 {len(must)} 条</h2>
{''.join(card(r, True) for r in must)}
<details class="rest"><summary>其余 {len(rest)} 条（可选，不看也行）：裁判有分歧、判不了的，飞书纪要的，以及抽查的</summary>
{''.join(card(r, False) for r in rest)}</details>
<script>
const MUST = {json.dumps(sorted(must_ids))};
let R = {{}};
const prog = () => document.getElementById("prog").textContent = MUST.filter(i => R[i] && R[i].v).length + "/" + MUST.length;
const paint = sec => {{ const r = R[sec.dataset.id] || {{}};
  sec.querySelectorAll(".ask button").forEach(b => b.classList.toggle("on", b.dataset.v === r.v));
  sec.querySelector(".note").value = r.note || ""; }};
async function save(id, patch) {{
  R[id] = {{...(R[id] || {{}}), ...patch, at: new Date().toISOString()}};
  const sec = document.getElementById(id); paint(sec); prog();
  try {{ const x = await fetch("api/review", {{method: "POST", headers: {{"Content-Type": "application/json"}}, body: JSON.stringify({{id, ...R[id]}})}});
    sec.querySelector(".saved").textContent = x.ok ? "已保存" : "保存失败";
  }} catch (e) {{ sec.querySelector(".saved").textContent = "保存失败"; }}
}}
document.querySelectorAll("section").forEach(sec => {{
  sec.querySelectorAll(".ask button").forEach(b => b.onclick = () => save(sec.dataset.id, {{v: b.dataset.v}}));
  sec.querySelector(".note").onchange = e => save(sec.dataset.id, {{note: e.target.value}});
}});
fetch("reviews.json?" + Date.now()).then(r => r.ok ? r.json() : {{}}).then(d => {{ R = d || {{}}; document.querySelectorAll("section").forEach(paint); prog(); }}).catch(() => {{}});
</script>"""
(A / "index.html").write_text(page)
print(A / "index.html", "必听", len(must), "其余", len(rest))
