"""人工标注页：会后情况 3 问、凭记忆写决议待办、认说话人、校对 6 段文字和说话人。

  python3 tests/eval/annotate.py ~/eval-data/weekly-1023      # 打开 http://127.0.0.1:8790
每次改动自动存到 <目录>/gold/*.json（另在 gold/history.jsonl 留每一版）。只监听本机；Host 不对的请求直接拒绝。
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

D = Path(sys.argv[1]).expanduser().resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
GOLD = D / "gold"
GOLD.mkdir(exist_ok=True)
KINDS = ("interview", "recall", "speakers", "clips")


def state() -> dict:
    man = json.loads((D / "manifest.json").read_text())
    ps = json.loads((D / "transcript.json").read_text())["paragraphs"]
    stats = {}
    for p in ps:
        s = stats.setdefault(str(p["spk"]), {"n": 0, "sec": 0})
        s["n"] += 1
        s["sec"] += (p["end"] - p["start"]) / 1000
    gold = {k: json.loads((GOLD / f"{k}.json").read_text()) for k in KINDS if (GOLD / f"{k}.json").exists()}
    return {"manifest": man, "spk_stats": stats, "gold": gold}


class H(BaseHTTPRequestHandler):
    def _ok_host(self):
        if self.headers.get("Host") not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            self.send_error(421)
            return False
        return True

    def _send(self, code, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._ok_host():
            return
        if self.path in ("/", "/index.html"):
            return self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        if self.path == "/api/state":
            return self._send(200, json.dumps(state(), ensure_ascii=False).encode(), "application/json")
        if self.path.startswith("/files/"):
            rel = self.path[len("/files/"):]
            f = (D / rel).resolve()
            if f.parent.name in ("clips", "samples") and f.parent.parent == D and f.suffix == ".wav" and f.exists():
                return self._send(200, f.read_bytes(), "audio/wav")
        self.send_error(404)

    def do_POST(self):
        if not self._ok_host():
            return
        if self.headers.get("Origin") not in (None, f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            return self.send_error(403)
        kind = self.path.rsplit("/", 1)[-1]
        if not self.path.startswith("/api/save/") or kind not in KINDS:
            return self.send_error(404)
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        (GOLD / f"{kind}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
        with open(GOLD / "history.jsonl", "a") as f:
            f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind, "data": data}, ensure_ascii=False) + "\n")
        self._send(200, b'{"ok":true}', "application/json")

    def log_message(self, *a):
        pass


PAGE = r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>会议评测 · 人工标注</title>
<style>
:root{--fg:#171717;--muted:#646464;--line:#e5e5e5;--bg:#fafafa;--acc:#0d74ce;--ok:#18794e}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--fg);background:var(--bg)}
header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--line);padding:10px 24px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header b{font-size:16px}header .st{color:var(--muted);font-size:13px}header .st .done{color:var(--ok)}#saved{margin-left:auto;color:var(--muted);font-size:13px}
main{max-width:1000px;margin:0 auto;padding:8px 24px 80px}
section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:18px 0}
h2{font-size:17px;margin:0 0 4px}.hint{color:var(--muted);font-size:13px;margin:0 0 12px}
label.q{display:block;font-weight:600;margin:14px 0 6px}textarea,input[type=text],select{font:inherit;width:100%;border:1px solid #d4d4d4;border-radius:6px;padding:7px 9px;background:#fff}
textarea{min-height:84px;resize:vertical}.radios label{margin-right:16px;white-space:nowrap}
.spk{display:grid;grid-template-columns:150px 1fr 220px;gap:10px 16px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
.spk:first-of-type{border-top:0}.spk .meta{color:var(--muted);font-size:13px}.smp{display:flex;align-items:center;gap:8px;margin:2px 0}.smp span{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
button{font:inherit;border:1px solid #d4d4d4;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;min-height:32px}button:hover{background:#f5f5f5}
button.play{width:34px;padding:0}.clip h3{font-size:15px;margin:0}.clip .bar{display:flex;gap:12px;align-items:center;margin:6px 0 10px;flex-wrap:wrap}
.clip audio{height:36px;flex:1;min-width:260px}.rows{display:grid;grid-template-columns:34px 52px 140px 1fr 30px 30px;gap:6px 8px;align-items:center}
.rows .t{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.rows select.auto{color:var(--muted)}.rows .playing{outline:2px solid var(--acc)}
.done-row{margin-top:12px;display:flex;align-items:center;gap:8px}.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 14px}.tabs button.on{border-color:var(--fg);background:var(--fg);color:#fff}
.warn{background:#fff8e6;border:1px solid #f3d38a;border-radius:8px;padding:10px 12px;font-size:14px}
</style></head><body>
<header><b>会议评测 · 人工标注</b><span class="st" id="st"></span><span id="saved">改动会自动保存</span></header>
<main>
<div class="warn" style="margin-top:16px">按顺序做。<b>做完第 2 步之前不要打开 10-23 周会的 AI 纪要</b>：先凭记忆写，才能测出纪要漏记了什么。全部做完大约 75 分钟，可以分几次做，关掉页面不会丢。</div>
<section id="s1"><h2>1 · 会后发生了什么（约 5 分钟）</h2><p class="hint">写真实发生的事，不写“应该怎样”。一两句话就行。</p><div id="iv"></div></section>
<section id="s2"><h2>2 · 凭记忆写下 10-23 周会的决议和待办（约 15 分钟）</h2>
<p class="hint">一行一条。格式随意，能写出“谁 · 做什么 · 什么时候”最好；不确定的写“不确定”。只写你记得的，不要去翻录音。</p><div id="rc"></div></section>
<section id="s3"><h2>3 · 认人（约 10 分钟）</h2><p class="hint">产品把这场会分成了 9 个说话人。听每个编号的样本，写出是谁。同一个人被分成了两个编号，就写同一个名字；听不出就勾“听不出”。</p><div id="sp"></div></section>
<section id="s4"><h2>4 · 校对 6 段，每段约 2 分钟（约 45 分钟）</h2>
<p class="hint">文字是另一个识别模型预填的，会有错。逐句点 ▶ 听，把文字改成实际说的话（口头禅、重复也照写，听不清写 [听不清]），选出说话人。
选了某一句的说话人，下面空着的句子会自动沿用（灰色），直到你选过的下一句。句子切得不对可以加行、删行。</p>
<div class="tabs" id="tabs"></div><div id="clip"></div></section>
</main>
<script>
const $ = (s, el = document) => el.querySelector(s);
let S, G = {}, cur = 0, timers = {};
const QS = [
 ["q1", "10-23 周会之后，你或团队里谁把会上的什么带到了会外（派任务、发消息、写进周报或文档）？用的什么工具、花了多久？没有就写“没有”。"],
 ["q2", "最近一次需要回想“会上谁说了 / 定了什么”，是什么时候？当时怎么找的，找到了吗？"],
 ["q3", "全天模式只开了 10-23 一天；问答、笔记、给说话人改名都没用过。各是什么原因（没想到、不需要、不信它、太麻烦、别的）？"]];
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
function save(kind) {
  clearTimeout(timers[kind]);
  timers[kind] = setTimeout(async () => {
    const r = await fetch("/api/save/" + kind, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(G[kind])});
    $("#saved").textContent = r.ok ? "已保存 " + new Date().toLocaleTimeString() : "保存失败";
    status();
  }, 500);
}
function names() {
  const n = Object.values(G.speakers || {}).map(v => (v.name || "").trim()).filter(Boolean);
  return [...new Set(n)];
}
function status() {
  const iv = QS.filter(([k]) => (G.interview?.[k] || "").trim()).length;
  const sp = Object.values(G.speakers || {}).filter(v => (v.name || "").trim() || v.unknown).length;
  const total = Object.keys(S.manifest.samples).length;
  const cl = (G.clips ? Object.values(G.clips).filter(c => c.done).length : 0);
  const d = (ok, t) => `<span class="${ok ? "done" : ""}">${t}</span>`;
  $("#st").innerHTML = [d(iv === 3 && G.interview?.seen, `问题 ${iv}/3`), d((G.recall?.text || "").trim() && G.recall?.source, "清单" + ((G.recall?.text || "").trim() ? " 已写" : " 未写")),
    d(sp === total, `认人 ${sp}/${total}`), d(cl === S.manifest.clips.length, `校对 ${cl}/${S.manifest.clips.length}`)].join(" · ");
}
function renderInterview() {
  G.interview = G.interview || {};
  $("#iv").innerHTML = QS.map(([k, q]) => `<label class="q">${q}</label><textarea data-k="${k}">${esc(G.interview[k])}</textarea>`).join("") +
    `<label class="q">你看过 10-23 周会的那份 AI 纪要吗？</label><div class="radios">` +
    [["no", "没看过"], ["glance", "扫过一眼"], ["read", "仔细看过"]].map(([v, t]) =>
      `<label><input type="radio" name="seen" value="${v}" ${G.interview.seen === v ? "checked" : ""}> ${t}</label>`).join("") + `</div>`;
  $("#iv").oninput = e => { const t = e.target; if (t.dataset.k) G.interview[t.dataset.k] = t.value; if (t.name === "seen") G.interview.seen = t.value; save("interview"); };
}
function renderRecall() {
  G.recall = G.recall || {};
  $("#rc").innerHTML = `<textarea id="rct" style="min-height:220px" placeholder="例：张三 · 下周三前把竞品价格表更新到飞书 · 下周三">${esc(G.recall.text)}</textarea>
   <label class="q">写的时候参考了什么？</label><div class="radios">` + [["memory", "只凭记忆"], ["notes", "看了自己的笔记"], ["chat", "看了聊天记录 / 飞书"], ["minutes", "看了 AI 纪要"]].map(([v, t]) =>
      `<label><input type="radio" name="src" value="${v}" ${G.recall.source === v ? "checked" : ""}> ${t}</label>`).join("") + `</div>`;
  $("#rc").oninput = e => { if (e.target.id === "rct") { G.recall.text = e.target.value; G.recall.t = new Date().toISOString(); } if (e.target.name === "src") G.recall.source = e.target.value; save("recall"); };
}
function renderSpeakers() {
  G.speakers = G.speakers || {};
  const sm = S.manifest.samples;
  $("#sp").innerHTML = `<datalist id="nl"></datalist>` + Object.keys(sm).map(k => {
    const st = S.spk_stats[k] || {n: 0, sec: 0}, v = G.speakers[k] || {};
    return `<div class="spk"><div><b>说话人 ${k}</b><div class="meta">${st.n} 段 · ${Math.round(st.sec / 60 * 10) / 10} 分钟</div></div>
      <div>${sm[k].map(x => `<div class="smp"><button class="play" data-src="${x.file}" aria-label="播放样本">▶</button><span title="${esc(x.text)}">${fmt(x.start)} ${esc(x.text)}</span></div>`).join("")}</div>
      <div><input type="text" list="nl" data-spk="${k}" placeholder="是谁" value="${esc(v.name)}"><label style="font-size:13px;color:var(--muted)"><input type="checkbox" data-unk="${k}" ${v.unknown ? "checked" : ""}> 听不出 / 不是人声</label></div></div>`;
  }).join("");
  const nl = () => { $("#nl").innerHTML = names().map(n => `<option value="${esc(n)}">`).join(""); };
  nl();
  $("#sp").oninput = e => { const t = e.target, k = t.dataset.spk || t.dataset.unk; if (k == null) return;
    G.speakers[k] = G.speakers[k] || {}; if (t.dataset.spk) G.speakers[k].name = t.value; else G.speakers[k].unknown = t.checked; nl(); save("speakers");
    clearTimeout(timers.rc); timers.rc = setTimeout(renderClip, 800); };
}
let player = new Audio(), stopAt = null, playingRow = null;
player.ontimeupdate = () => { if (stopAt != null && player.currentTime >= stopAt) { player.pause(); stopAt = null; } };
player.onpause = () => { if (playingRow) playingRow.classList.remove("playing"); playingRow = null; };
document.addEventListener("click", e => { const b = e.target.closest("button.play[data-src]"); if (!b) return;
  player.src = "/files/" + b.dataset.src; stopAt = null; player.play(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") player.pause(); });
function clipState(c) {
  G.clips = G.clips || {};
  if (!G.clips[c.id]) G.clips[c.id] = {rows: c.prefill.map(r => ({start: r.start, end: r.end, text: r.text, spk: "", auto: false, prefill: r.text})), done: false};
  return G.clips[c.id];
}
function renderTabs() {
  $("#tabs").innerHTML = S.manifest.clips.map((c, i) => `<button class="${i === cur ? "on" : ""}" data-i="${i}">片段 ${i + 1}${G.clips?.[c.id]?.done ? "（已完成）" : ""}</button>`).join("");
  $("#tabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; cur = +b.dataset.i; renderTabs(); renderClip(); };
}
function renderClip() {
  const c = S.manifest.clips[cur], st = clipState(c), opts = [...names(), "其他人", "多人同时说", "听不出"];
  $("#clip").innerHTML = `<div class="clip"><h3>片段 ${cur + 1}：会议的 ${fmt(c.start)}–${fmt(c.end)}</h3>
    <div class="bar"><audio id="ca" controls preload="metadata" src="/files/${c.file}"></audio></div>
    <div class="rows" id="rows">${st.rows.map((r, i) => `<button class="play" data-row="${i}" aria-label="播放这一句">▶</button><span class="t">${fmt(r.start)}</span>
      <select data-i="${i}" class="${r.auto ? "auto" : ""}"><option value="">说话人</option>${opts.map(n => `<option ${r.spk === n ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <input type="text" data-i="${i}" value="${esc(r.text)}"><button data-add="${i}" title="在下面加一行" aria-label="在下面加一行">+</button><button data-del="${i}" title="删掉这一行" aria-label="删掉这一行">×</button>`).join("")}</div>
    <div class="done-row"><label><input type="checkbox" id="cdone" ${st.done ? "checked" : ""}> 这一段我从头到尾听过，文字和说话人都改好了</label></div></div>`;
  const ca = $("#ca");
  $("#rows").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.row != null) { const r = st.rows[+b.dataset.row]; player.pause(); ca.currentTime = r.start / 1000; ca.play();
      const stop = (r.end + 300) / 1000; ca.ontimeupdate = () => { if (ca.currentTime >= stop) { ca.pause(); ca.ontimeupdate = null; } }; return; }
    if (b.dataset.add != null) { const i = +b.dataset.add, r = st.rows[i]; st.rows.splice(i + 1, 0, {start: r.end, end: r.end, text: "", spk: r.spk, auto: true, prefill: ""}); }
    if (b.dataset.del != null) { if (!confirm("删掉这一行？")) return; st.rows.splice(+b.dataset.del, 1); }
    save("clips"); renderClip();
  };
  $("#rows").onchange = e => { const t = e.target; if (t.tagName !== "SELECT") return; const i = +t.dataset.i;
    st.rows[i].spk = t.value; st.rows[i].auto = false;
    for (let j = i + 1; j < st.rows.length && (st.rows[j].auto || !st.rows[j].spk); j++) { st.rows[j].spk = t.value; st.rows[j].auto = true; }
    save("clips"); renderClip(); };
  $("#rows").oninput = e => { const t = e.target; if (t.tagName === "INPUT") { st.rows[+t.dataset.i].text = t.value; save("clips"); } };
  $("#cdone").onchange = e => {
    if (e.target.checked && st.rows.some(r => !r.spk)) { alert("还有句子没选说话人"); e.target.checked = false; return; }
    st.done = e.target.checked; save("clips"); renderTabs(); };
}
(async () => {
  S = await (await fetch("/api/state")).json(); G = S.gold || {};
  renderInterview(); renderRecall(); renderSpeakers(); renderTabs(); renderClip(); status();
})();
</script></body></html>"""

if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
