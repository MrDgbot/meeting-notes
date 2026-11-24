// 每日时间线与当日汇总
import {
  $, S, autoIc, esc, flashDone, fmtDur, ic, icSwap, providerOptions, statusTag, ymd,
} from "./utils.js";
import { api, ensureSettings, streamNd } from "./api.js";
import { md } from "./markdown.js";
import { copyText, confirmAction, hoverFill, sbCleanup, toast } from "./ui.js";
import { startLocalLlm } from "./meeting.js";

export async function showDay(date, seq = S.routeSeq) {
  let d;
  try {
    d = await api("/api/days/" + date);
  } catch (e) {
    if (seq !== S.routeSeq || location.hash !== "#/day/" + date) return;
    $("#main").innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}</div></div>`;
    sbCleanup();
    return;
  }
  await ensureSettings();
  if (seq !== S.routeSeq || location.hash !== "#/day/" + date) return;
  const dt = new Date(date + "T00:00:00");
  const label = `${dt.getMonth() + 1}月${dt.getDate()}日 周${"日一二三四五六"[dt.getDay()]}`;
  const shift = n => { const x = new Date(dt); x.setDate(x.getDate() + n); return ymd(x); };
  const ms = d.meetings, sm = d.summary, isToday = date === ymd(new Date());
  const speech = ms.reduce((a, m) => a + (m.source === "ambient" ? (m.speech_s || 0) : (m.duration || 0)), 0);
  const busy = ms.filter(m => ["recording", "queued", "transcribing"].includes(m.status)).length;
  const ae = d.auto_error, stale = d.summary_stale;
  const dayNote = ae ? `<div class="banner err small"><span class="grow">${ae.final ? "自动汇总失败，今天不会再自动重试" : ae.tries ? `自动汇总失败（第 ${ae.tries} 次，30 分钟后自动重试）` : "自动汇总没有生成"}：${esc(ae.error)}</span></div>`
    : stale ? `<div class="banner warn small"><span class="grow">这份汇总生成后${stale.new ? `新增了 ${stale.new} 段记录` : ""}${stale.new && stale.changed ? "，" : ""}${stale.changed && !stale.new ? "记录内容有改动（文字、说话人姓名或纪要）" : stale.changed ? "已有记录也有改动" : ""}，汇总里没有包含。</span><button class="sm" id="dayRegen">${ic("sparkle")}重新生成</button></div>` : "";

  $("#main").innerHTML = `<div class="wrap">
    <div class="mhead"><div class="grow"><h1>${esc(label)}${isToday ? ` <span class="tag">今天</span>` : ""}</h1>
      <div class="meta-line"><span>${ic("file")}${ms.length} 段记录</span><span>${ic("speech")}发言约 ${fmtDur(speech)}</span>${busy ? `<span>${busy} 段还在记录/转写</span>` : ""}</div></div>
      <div class="row" style="gap:6px"><a class="btn" href="#/day/${shift(-1)}">${ic("left")}前一天</a>${isToday ? "" : `<a class="btn" href="#/day/${shift(1)}">后一天${ic("right")}</a>`}</div></div>
    <div class="daygrid">
      <div class="card"><h2>时间线</h2><div class="timeline">${ms.map(m => `<a class="tl" href="#/m/${esc(m.id)}">
        <span class="tm">${esc(m.clock_start)}${m.clock_end && m.clock_end !== m.clock_start ? "–" + esc(m.clock_end) : ""}</span>
        <span class="tb"><span class="t">${esc(m.title)}</span><span class="s">${fmtDur(m.source === "ambient" ? m.speech_s : m.duration)}${m.num_speakers ? ` · ${m.num_speakers} 人` : ""}${autoIc(m)}${statusTag(m)}</span></span></a>`).join("")
        || `<div class="empty">这一天没有记录</div>`}</div></div>
      <div class="card"><div class="toolbar"><h2 style="margin:0" class="grow">当日汇总</h2>
          <select id="provSel" style="max-width:210px" aria-label="用哪个模型生成">${providerOptions()}</select>
          <button class="pri" id="dayGen" ${ms.length ? "" : "disabled"}>${ic("sparkle")}${sm ? "重新生成" : "生成汇总"}</button>
          ${sm ? `<button id="dayCopy">${icSwap("copy", "check")}复制</button>` : ""}</div>
        <div class="muted small" id="dayState" style="margin:-6px 0 10px">${sm ? `${esc(sm.provider)} · ${esc(sm.model)} · ${esc(sm.created.replace("T", " ").slice(0, 16))} · 用时 ${esc(sm.cost)}s` : ""}</div>
        ${dayNote}
        <div class="md" id="dayBox">${sm ? md(sm.markdown) : `<div class="empty">${ms.length ? "把这一天的所有对话和会议整理成一份工作汇总：概览、时间线、决定、待办、值得记住的信息" : "这一天没有记录"}</div>`}</div></div>
    </div></div>`;
  sbCleanup();
  hoverFill($(".timeline"), ".tl");
  $("#dayCopy") && ($("#dayCopy").onclick = e => {
    const b = e.currentTarget;
    copyText(sm.markdown, "").then(ok => ok && flashDone(b));
  });
  const gen = async () => {
    const btn = $("#dayGen"), box = $("#dayBox"), st = $("#dayState");
    if (btn.disabled) return;
    if (busy && !(await confirmAction({
      title: "部分内容仍在转写中",
      message: `还有 ${busy} 段正在记录或转写，现在生成会使用它们当前的实时文字。确定继续吗？`,
      confirmText: "继续生成",
    }))) return;
    btn.disabled = true; st.textContent = "准备中…";
    let text = "", raf = 0; const t0 = Date.now();
    const paint = () => {
      raf = 0;
      if (!box.isConnected) return;
      box.innerHTML = md(text);
      box.lastElementChild && box.lastElementChild.classList.add("cursor");
    };
    try {
      await streamNd(`/api/days/${date}/summary`, { provider: $("#provSel").value }, ev => {
        if (ev.type === "status") { if (st.isConnected) st.textContent = ev.msg; }
        else if (ev.type === "delta") {
          text += ev.text;
          if (st.isConnected) st.textContent = `生成中… ${text.length} 字 · ${Math.round((Date.now() - t0) / 1000)}s`;
          if (!raf) raf = requestAnimationFrame(paint);
        } else if (ev.type === "error") throw new Error(ev.msg);
      });
      cancelAnimationFrame(raf); raf = 0;
      if (location.hash === "#/day/" + date) showDay(date);
    } catch (e) {
      cancelAnimationFrame(raf); raf = 0;
      if (st.isConnected) st.textContent = "";
      if (btn.isConnected) btn.disabled = false;
      toast("生成失败：" + e.message, 6000);
      if (box.isConnected) {
        if (!text) {
          box.innerHTML = `<div class="empty" style="color:var(--red)">${esc(e.message)}${/本地模型还没启动/.test(e.message) ? `<div style="margin-top:10px"><button class="sm" id="llmStart">启动本地模型</button></div>` : ""}</div>`;
          $("#llmStart") && ($("#llmStart").onclick = ev => startLocalLlm(ev.currentTarget));
        } else {
          box.innerHTML = md(text);
        }
      }
    }
  };
  $("#dayGen").onclick = gen;
  $("#dayRegen") && ($("#dayRegen").onclick = gen);
}
