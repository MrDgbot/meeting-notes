import {
  $, $$, S, esc, fmtDur, hm, hooks, ic, statusTag, tsToSec,
} from "./utils.js";
import { api } from "./api.js";
import { closeModal, confirmAction, modal, sbCleanup, toast } from "./ui.js";

export async function loadRelatedMeetings(mid, host) {
  if (!mid || !host) return;
  let r;
  try {
    r = await api(`/api/meetings/${encodeURIComponent(mid)}/related?limit=5`);
  } catch {
    return;
  }
  if (!host.isConnected || !S.cur || S.cur.meta.id !== mid) return;
  const items = (r && r.items) || [];
  if (!items.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<section class="card rel-card" aria-label="相关历史会议">
    <div class="rel-head">
      <h2>${ic("users")}相关历史会议</h2>
      <span class="muted small">基于共同参会人与高频主题词本机关联</span>
    </div>
    <div class="rel-list">${items.map(it => {
      const reasons = [
        ...(it.shared_speakers || []).map(s => `<span class="rel-pill rel-spk">${esc(s)}</span>`),
        ...(it.shared_terms || []).slice(0, 3).map(t => `<span class="rel-pill">${esc(t)}</span>`),
      ].join("");
      return `<a class="rel-item" href="#/m/${esc(it.id)}">
        <div class="rel-main">
          <div class="rel-t">${esc(it.title)}</div>
          <div class="rel-meta muted small"><span class="num">${esc(String(it.created || "").slice(5, 10))} ${hm(it.created)}</span><span>·</span><span>${fmtDur(it.duration)}</span>${it.has_minutes ? `<span>·</span><span>有纪要</span>` : ""}</div>
        </div>
        <div class="rel-tags">${reasons}</div>
      </a>`;
    }).join("")}</div>
  </section>`;
}

let todoStatus = "open";
let todoPerson = "";

export async function showTodos(seq = S.routeSeq) {
  const main = $("#main");
  main.innerHTML = `<div class="wrap"><div class="empty">加载待办总览…</div></div>`;
  let data, peopleRes;
  try {
    [data, peopleRes] = await Promise.all([
      api(`/api/todos?status=${encodeURIComponent(todoStatus)}&person=${encodeURIComponent(todoPerson)}`),
      api("/api/people").catch(() => ({ people: [] })),
    ]);
  } catch (e) {
    if (seq !== S.routeSeq || location.hash !== "#/todos") return;
    main.innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}</div></div>`;
    sbCleanup();
    return;
  }
  if (seq !== S.routeSeq || location.hash !== "#/todos") return;

  const counts = (data && data.counts) || { open: 0, done: 0, total: 0 };
  const items = (data && data.items) || [];
  const people = (peopleRes && peopleRes.people) || [];

  const groups = new Map();
  for (const it of items) {
    let g = groups.get(it.mid);
    if (!g) {
      g = { mid: it.mid, title: it.meeting_title, created: it.meeting_created, items: [] };
      groups.set(it.mid, g);
    }
    g.items.push(it);
  }

  main.innerHTML = `<div class="wrap hub-wrap">
    <div class="hub-top">
      <div>
        <h1>待办中心</h1>
        <p class="muted small">自动聚合全部会议纪要里的行动项，勾选后同步回原纪要</p>
      </div>
      <div class="hub-nav">
        <a class="home-pill" href="#/people">${ic("users")}<span>人物</span></a>
        <a class="home-pill" href="#/">${ic("left")}<span>回到首页</span></a>
      </div>
    </div>

    <div class="hub-bar">
      <div class="hub-seg" role="group" aria-label="按状态筛选待办">
        <button type="button" class="sf-pill${todoStatus === "open" ? " on" : ""}" data-tst="open" aria-pressed="${todoStatus === "open"}">未完成 <span class="num">${counts.open}</span></button>
        <button type="button" class="sf-pill${todoStatus === "done" ? " on" : ""}" data-tst="done" aria-pressed="${todoStatus === "done"}">已完成 <span class="num">${counts.done}</span></button>
        <button type="button" class="sf-pill${todoStatus === "all" ? " on" : ""}" data-tst="all" aria-pressed="${todoStatus === "all"}">全部 <span class="num">${counts.total}</span></button>
      </div>
      ${people.length ? `<select id="todoPersonSel" class="home-sel hub-sel" aria-label="按人物筛选待办">
        <option value="">全部人物</option>
        ${people.map(p => `<option value="${esc(p.name)}" ${todoPerson === p.name ? "selected" : ""}>${esc(p.name)}（${p.meetings} 场）</option>`).join("")}
      </select>` : ""}
    </div>

    <div class="hub-list" id="todoHubList">${groups.size
      ? [...groups.values()].map(g => `<section class="card todo-grp">
          <div class="todo-grp-h">
            <a class="todo-grp-t" href="#/m/${esc(g.mid)}">${esc(g.title)}</a>
            <span class="muted small num">${esc(String(g.created || "").slice(0, 10))} ${hm(g.created)}</span>
          </div>
          <ul class="todo-ul">${g.items.map(it => {
            const seekSec = it.ts ? tsToSec(it.ts) : 0;
            const href = seekSec > 0 ? `#/m/${esc(it.mid)}?t=${seekSec}` : `#/m/${esc(it.mid)}`;
            return `<li class="todo-row-collapse"><div><div class="todo-row${it.done ? " todo-done" : ""}">
            <label class="todo-row-lbl">
              <input type="checkbox" class="cb" data-mid="${esc(it.mid)}" data-idx="${it.idx}" aria-label="切换待办完成状态" ${it.done ? "checked" : ""}>
              <span class="todo-txt">${esc(it.text)}</span>
            </label>
            ${it.ts ? `<a class="ts todo-ts" href="${href}" title="跳到原会议 [${esc(it.ts)}]">[${esc(it.ts)}]</a>` : ""}
          </div></div></li>`;
          }).join("")}</ul>
        </section>`).join("")
      : `<div class="card home-empty muted">${todoStatus === "open" ? "当前没有未完成的待办事项，太棒了！" : "这个筛选下还没有待办项（在会议详情生成 AI 纪要后会自动汇总到这里）。"}</div>`
    }</div>
  </div>`;
  sbCleanup();

  $$("[data-tst]", main).forEach(btn => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.tst;
      if (next === todoStatus) return;
      todoStatus = next;
      showTodos(S.routeSeq);
    });
  });
  const psel = $("#todoPersonSel", main);
  if (psel) {
    psel.addEventListener("change", () => {
      todoPerson = psel.value;
      showTodos(S.routeSeq);
    });
  }
  const syncCounts = deltaDone => {
    counts.open = Math.max(0, counts.open - deltaDone);
    counts.done = Math.max(0, counts.done + deltaDone);
    const openEl = $('[data-tst="open"] .num', main);
    const doneEl = $('[data-tst="done"] .num', main);
    if (openEl) openEl.textContent = String(counts.open);
    if (doneEl) doneEl.textContent = String(counts.done);
  };
  const listEl = $("#todoHubList", main);
  if (listEl) {
    listEl.addEventListener("change", async e => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.matches("input.cb[data-mid]")) return;
      const mid = cb.dataset.mid, idx = Number(cb.dataset.idx), done = cb.checked;
      const row = cb.closest(".todo-row"), li = cb.closest("li.todo-row-collapse");
      cb.disabled = true;
      if (row) row.classList.toggle("todo-done", done);
      try {
        await api("/api/todos/toggle", { method: "POST", body: { mid, idx, done } });
        syncCounts(done ? 1 : -1);
        cb.disabled = false;
        const hideRow = (todoStatus === "open" && done) || (todoStatus === "done" && !done);
        if (hideRow && li) {
          setTimeout(() => {
            if (!li.isConnected) return;
            li.classList.add("is-collapsing");
            setTimeout(() => {
              if (!li.isConnected) return;
              const sec = li.closest("section.todo-grp");
              li.remove();
              if (sec && !$("li", sec)) sec.remove();
              if (!$("#todoHubList section", main)) {
                $("#todoHubList", main).innerHTML = `<div class="card home-empty muted">${todoStatus === "open" ? "当前没有未完成的待办事项，太棒了！" : "这个筛选下还没有待办项。"}</div>`;
              }
            }, 220);
          }, 280);
        }
        toast(done ? "已完成，已同步到原会议纪要" : "已恢复为未完成", {
          ms: 5000,
          action: {
            label: "撤销",
            onClick: async () => {
              await api("/api/todos/toggle", { method: "POST", body: { mid, idx, done: !done } });
              showTodos(S.routeSeq);
              toast("已撤销待办变更");
            },
          },
        });
      } catch (err) {
        cb.checked = !done;
        if (row) row.classList.toggle("todo-done", !done);
        cb.disabled = false;
        toast("更新失败：" + err.message, 4500);
      }
    });
  }
}

export async function showPeople(seq = S.routeSeq) {
  const main = $("#main");
  main.innerHTML = `<div class="wrap"><div class="empty">加载人物列表…</div></div>`;
  let r;
  try {
    r = await api("/api/people");
  } catch (e) {
    if (seq !== S.routeSeq || location.hash !== "#/people") return;
    main.innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}</div></div>`;
    sbCleanup();
    return;
  }
  if (seq !== S.routeSeq || location.hash !== "#/people") return;
  const people = (r && r.people) || [];
  main.innerHTML = `<div class="wrap hub-wrap">
    <div class="hub-top">
      <div>
        <h1>人物与发言统计</h1>
        <p class="muted small">按已确认姓名聚合跨会议历史、共同参会人、高频主题与待办</p>
      </div>
      <div class="hub-nav">
        <a class="home-pill" href="#/todos">${ic("check")}<span>待办中心</span></a>
        <a class="home-pill" href="#/">${ic("left")}<span>回到首页</span></a>
      </div>
    </div>
    ${people.length ? `<div class="person-grid stagger">${people.map((p, i) => `<a class="card person-card" style="--i:${i}" href="#/people/${encodeURIComponent(p.name)}">
      <div class="person-head">
        <span class="person-av" aria-hidden="true">${esc(p.name.slice(0, 1))}</span>
        <div class="grow" style="min-width:0">
          <div class="person-name">${esc(p.name)}</div>
          <div class="muted small">最近出现 <span class="num">${esc(String(p.last_seen || "").slice(0, 10))}</span></div>
        </div>
        ${p.open_todos ? `<span class="tag">${p.open_todos} 待办</span>` : ""}
      </div>
      <div class="person-stats muted small">
        <span><b class="num">${p.meetings}</b> 场会议</span>
        <span>·</span>
        <span>累计 <b class="num">${fmtDur(p.total_s)}</b></span>
      </div>
    </a>`).join("")}</div>`
      : `<div class="card home-empty muted">还没有具名发言人。在会议转写稿里把「说话人1/2」改成真实姓名后，这里会自动串起 TA 的全部历史会议与待办。</div>`}
  </div>`;
  sbCleanup();
}

export async function showPerson(name, seq = S.routeSeq) {
  const main = $("#main");
  main.innerHTML = `<div class="wrap"><div class="empty">加载 ${esc(name)} 的历史关联…</div></div>`;
  let d, pplRes;
  try {
    [d, pplRes] = await Promise.all([
      api("/api/people/" + encodeURIComponent(name)),
      api("/api/people").catch(() => ({ people: [] })),
    ]);
  } catch (e) {
    if (seq !== S.routeSeq) return;
    main.innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}</div></div>`;
    sbCleanup();
    return;
  }
  if (seq !== S.routeSeq) return;

  const meetings = d.meetings || [];
  const co = d.co_speakers || [];
  const terms = d.top_terms || [];
  const todos = d.todos || [];
  const openTodos = todos.filter(t => !t.done);
  const allPeople = (pplRes && pplRes.people) || [];
  const others = allPeople.filter(p => p.name !== name);

  main.innerHTML = `<div class="wrap hub-wrap">
    <div class="hub-top">
      <div>
        <div class="row" style="gap:10px">
          <span class="person-av person-av-lg" aria-hidden="true">${esc((d.name || "?").slice(0, 1))}</span>
          <div>
            <h1>${esc(d.name)}</h1>
            <p class="muted small"><span class="num">${d.total_meetings}</span> 场会议 · 累计发言 <span class="num">${fmtDur(d.total_s)}</span> · 未完成待办 <span class="num">${openTodos.length}</span> 项${d.voiceprint_sessions ? ` · 已建声纹 <span class="num">${d.voiceprint_sessions}</span> 场` : ""}</p>
          </div>
        </div>
      </div>
      <div class="hub-nav">
        <button type="button" class="home-pill" id="personRenameBtn">${ic("edit")}<span>改名 / 合并</span></button>
        <button type="button" class="home-pill" id="personClearBtn"><span>清除命名</span></button>
        <a class="home-pill" href="#/people">${ic("left")}<span>全部人物</span></a>
        <a class="home-pill" href="#/todos">${ic("check")}<span>待办中心</span></a>
      </div>
    </div>

    ${(terms.length || co.length) ? `<div class="card person-meta-card">
      ${terms.length ? `<div class="pm-row"><span class="muted small">高频话题</span><div class="rel-tags">${terms.map(t => `<span class="rel-pill">${esc(t)}</span>`).join("")}</div></div>` : ""}
      ${co.length ? `<div class="pm-row"><span class="muted small">常一起开会</span><div class="rel-tags">${co.map(c => `<a class="rel-pill rel-spk" href="#/people/${encodeURIComponent(c.name)}">${esc(c.name)} · ${c.count}</a>`).join("")}</div></div>` : ""}
    </div>` : ""}

    <div class="daygrid">
      <section class="card">
        <h2>相关会议（${meetings.length}）</h2>
        <div class="timeline">${meetings.map(m => `<div class="tl-wrap">
          <a class="tl" href="#/m/${esc(m.id)}">
            <span class="tm num">${esc(String(m.created || "").slice(5, 10))} ${hm(m.created)}</span>
            <span class="tb"><span class="t">${esc(m.title)}</span><span class="s">发言 ${fmtDur(m.spoken_s)}${m.has_minutes ? " · 有纪要" : ""}${statusTag(m)}</span></span>
          </a>
          <button type="button" class="ghost sm tl-fix" data-fix-mid="${esc(m.id)}" aria-label="改人：${esc(m.title)}" title="修改本场发言人">改人</button>
        </div>`).join("") || `<div class="empty">暂无会议记录</div>`}</div>
      </section>
      <section class="card">
        <h2>相关待办（${openTodos.length} 未完成 / ${todos.length}）</h2>
        <ul class="todo-ul" id="personTodoUl">${todos.map(it => `<li class="todo-row${it.done ? " todo-done" : ""}">
          <input type="checkbox" class="cb" data-mid="${esc(it.mid)}" data-idx="${it.idx}" aria-label="切换待办完成状态" ${it.done ? "checked" : ""}>
          <div class="grow" style="min-width:0">
            <div class="todo-txt">${esc(it.text)}</div>
            <div class="muted small"><a class="todo-src" href="#/m/${esc(it.mid)}">${esc(it.meeting_title)}</a> · <span class="num">${esc(String(it.meeting_created || "").slice(5, 10))}</span></div>
          </div>
        </li>`).join("") || `<li class="empty">暂无关联待办</li>`}</ul>
      </section>
    </div>
  </div>`;
  sbCleanup();

  const chipsHtml = others.length
    ? `<div class="muted small" style="margin:8px 0 4px">或合并到已有人物：</div>
       <div class="rel-tags">${others.slice(0, 8).map(p => `<button type="button" class="sf-pill" data-pick="${esc(p.name)}" style="min-height:28px">${esc(p.name)}</button>`).join("")}</div>`
    : "";

  const renBtn = $("#personRenameBtn", main);
  if (renBtn) {
    renBtn.onclick = () => {
      const dlg = modal(`<div class="dlg-head"><h3>修改或合并人物</h3>
        <button type="button" class="ghost sm ic-btn" id="prClose" aria-label="关闭弹窗">${ic("x")}</button></div>
        <p class="muted small" style="margin:0 0 8px">当前人物：<b>${esc(name)}</b></p>
        <input id="prInput" value="${esc(name)}" maxlength="32" placeholder="输入新姓名（写已有人物名会自动合并）">
        ${chipsHtml}
        <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input type="checkbox" id="prMin" ${name.length >= 2 ? "checked" : ""}>
          <span>同时替换已生成纪要中的「${esc(name)}」</span>
        </label>
        <div class="row end" style="margin-top:14px">
          <button type="button" class="ghost" id="prCancel" style="min-height:36px">取消</button>
          <button type="button" class="pri" id="prOk" style="min-height:36px">保存修改</button>
        </div>`, { width: 420 });
      const inp = $("#prInput", dlg);
      setTimeout(() => { inp && inp.focus(); }, 20);
      $("#prClose", dlg).onclick = () => closeModal();
      $("#prCancel", dlg).onclick = () => closeModal();
      $$("[data-pick]", dlg).forEach(b => { b.onclick = () => { if (inp) inp.value = b.dataset.pick; }; });
      $("#prOk", dlg).onclick = async () => {
        const nextName = (inp && inp.value || "").trim();
        if (!nextName || nextName === name) return toast("请输入不同的新姓名");
        const okBtn = $("#prOk", dlg);
        okBtn.disabled = true;
        try {
          await api("/api/people/rename", {
            method: "POST",
            body: { old_name: name, new_name: nextName, update_minutes: Boolean($("#prMin", dlg).checked) },
          });
          closeModal(false);
          hooks.loadMeetings && void hooks.loadMeetings();
          toast(`已改名为「${nextName}」`);
          location.hash = "#/people/" + encodeURIComponent(nextName);
        } catch (err) {
          okBtn.disabled = false;
          toast("修改失败：" + err.message, 4500);
        }
      };
    };
  }

  const clrBtn = $("#personClearBtn", main);
  if (clrBtn) {
    clrBtn.onclick = async () => {
      const ok = await confirmAction({
        title: `清除「${name}」的命名？`,
        message: "会把所有会议中的这个名字恢复为未命名说话人并移除对应声纹档案，会议内容不会丢失。",
        confirmText: "确认清除",
        cancelText: "取消",
        danger: true,
      });
      if (!ok) return;
      try {
        await api("/api/people/clear", { method: "POST", body: { name } });
        hooks.loadMeetings && void hooks.loadMeetings();
        toast(`已清除「${name}」`);
        location.hash = "#/people";
      } catch (err) {
        toast("清除失败：" + err.message, 4500);
      }
    };
  }

  $$("[data-fix-mid]", main).forEach(btn => {
    btn.onclick = () => {
      const mid = btn.dataset.fixMid;
      const m = meetings.find(x => x.id === mid);
      if (!m) return;
      const dlg = modal(`<div class="dlg-head"><h3>修改本场发言人</h3>
        <button type="button" class="ghost sm ic-btn" id="pfClose" aria-label="关闭弹窗">${ic("x")}</button></div>
        <p class="muted small" style="margin:0 0 8px">${esc(m.title || "未命名会议")}</p>
        <input id="pfInput" value="" maxlength="32" placeholder="在这场会议里「${esc(name)}」实际是谁？">
        ${others.length ? `<div class="rel-tags" style="margin-top:8px">${others.slice(0, 8).map(p => `<button type="button" class="sf-pill" data-pick="${esc(p.name)}" style="min-height:28px">${esc(p.name)}</button>`).join("")}</div>` : ""}
        ${m.has_minutes ? `<label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input type="checkbox" id="pfMin" ${name.length >= 2 ? "checked" : ""}>
          <span>同时替换本场纪要中的「${esc(name)}」</span>
        </label>` : ""}
        <div class="row" style="justify-content:space-between;margin-top:14px;gap:8px;flex-wrap:wrap">
          <button type="button" class="ghost danger" id="pfAnon" style="min-height:36px">恢复为未命名</button>
          <div class="row" style="gap:8px">
            <button type="button" class="ghost" id="pfCancel" style="min-height:36px">取消</button>
            <button type="button" class="pri" id="pfOk" style="min-height:36px">确认修改</button>
          </div>
        </div>`, { width: 420 });
      const inp = $("#pfInput", dlg);
      setTimeout(() => { inp && inp.focus(); }, 20);
      $("#pfClose", dlg).onclick = () => closeModal();
      $("#pfCancel", dlg).onclick = () => closeModal();
      $$("[data-pick]", dlg).forEach(b => { b.onclick = () => { if (inp) inp.value = b.dataset.pick; }; });
      const runReassign = async newName => {
        try {
          await api("/api/people/reassign", {
            method: "POST",
            body: {
              mid,
              old_name: name,
              new_name: newName,
              spks: m.spks,
              update_minutes: Boolean(newName && $("#pfMin", dlg) && $("#pfMin", dlg).checked),
            },
          });
          closeModal(false);
          hooks.loadMeetings && void hooks.loadMeetings();
          toast(newName ? `已修改为「${newName}」` : "已恢复为未命名");
          showPerson(name, S.routeSeq);
        } catch (err) {
          toast("修改失败：" + err.message, 4500);
        }
      };
      $("#pfAnon", dlg).onclick = () => void runReassign("");
      $("#pfOk", dlg).onclick = () => {
        const nextName = (inp && inp.value || "").trim();
        if (!nextName || nextName === name) return toast("请输入新的姓名");
        void runReassign(nextName);
      };
    };
  });

  const ul = $("#personTodoUl", main);
  if (ul) {
    ul.addEventListener("change", async e => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.matches("input.cb[data-mid]")) return;
      const mid = cb.dataset.mid, idx = Number(cb.dataset.idx), done = cb.checked;
      const li = cb.closest("li");
      cb.disabled = true;
      if (li) li.classList.toggle("todo-done", done);
      try {
        await api("/api/todos/toggle", { method: "POST", body: { mid, idx, done } });
        toast(done ? "已完成，已同步到原会议纪要" : "已恢复为未完成", 1800);
        showPerson(name, S.routeSeq);
      } catch (err) {
        cb.checked = !done;
        if (li) li.classList.toggle("todo-done", !done);
        cb.disabled = false;
        toast("更新失败：" + err.message, 4500);
      }
    });
  }
}
