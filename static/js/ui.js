import { $, $$, IN_APP } from "./utils.js";

let toastT = 0, toastStart = 0, toastRem = 2600, toastBound = false;
function hideToast() {
  clearTimeout(toastT); toastT = 0;
  const t = $("#toast"); if (!t) return;
  t.classList.remove("show", "has-act");
}
function armToastTimer(ms) {
  clearTimeout(toastT);
  toastStart = Date.now();
  toastRem = ms;
  if (ms > 0) toastT = setTimeout(hideToast, ms);
}
export function toast(msg, msOrOpts = 2600) {
  const t = $("#toast"); if (!t) return;
  const opts = typeof msOrOpts === "number" ? { ms: msOrOpts } : (msOrOpts || {});
  const ms = opts.ms ?? 2600;
  const action = opts.action && typeof opts.action.onClick === "function" ? opts.action : null;
  if (!toastBound) {
    toastBound = true;
    const pause = () => {
      if (!toastT) return;
      clearTimeout(toastT); toastT = 0;
      toastRem = Math.max(600, toastRem - (Date.now() - toastStart));
    };
    const resume = () => {
      if (t.classList.contains("show") && !toastT && toastRem > 0) armToastTimer(toastRem);
    };
    t.addEventListener("pointerenter", pause);
    t.addEventListener("pointerleave", resume);
    t.addEventListener("focusin", pause);
    t.addEventListener("focusout", resume);
  }
  t.textContent = "";
  const span = document.createElement("span");
  span.className = "toast-msg";
  span.textContent = msg;
  t.appendChild(span);
  if (action && action.label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-act";
    btn.textContent = action.label;
    btn.onclick = () => {
      hideToast();
      Promise.resolve(action.onClick()).catch(err => toast("撤销失败：" + ((err && err.message) || err), 4500));
    };
    t.appendChild(btn);
    t.classList.add("has-act");
  } else {
    t.classList.remove("has-act");
  }
  t.classList.add("show");
  armToastTimer(ms);
}

export function playAudio(a) {
  if (!a) return;
  const p = a.play();
  if (p && typeof p.catch === "function") {
    p.catch(err => {
      if (err && err.name === "AbortError") return;
      toast("无法播放音频：" + (err && err.message ? err.message : "请再次点击播放"), 4000);
    });
  }
}

export function copyText(text, okMsg = "已复制", emptyMsg = "") {
  if (!text) { if (emptyMsg) toast(emptyMsg); return Promise.resolve(false); }
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    toast("当前浏览器不支持自动复制，请手动选中复制", 4000);
    return Promise.resolve(false);
  }
  return navigator.clipboard.writeText(text).then(
    () => { if (okMsg) toast(okMsg); return true; },
    () => { toast("复制失败，请检查浏览器的剪贴板权限", 4000); return false; },
  );
}

export function linkLabels(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("label.f").forEach(l => {
    if (l.htmlFor) return;
    let c = l.nextElementSibling;
    if (c && !c.matches("input,select,textarea")) c = c.querySelector("input:not([type=hidden]),select,textarea");
    if (!c) return;
    if (c.id) l.htmlFor = c.id;
    else if (!c.getAttribute("aria-label")) c.setAttribute("aria-label", l.textContent.trim());
  });
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
let modalT = null, modalOnClose = null, modalPrevFocus = null;

export function modal(html, onClose = null) {
  const m = $("#modal");
  clearTimeout(modalT);
  if (modalOnClose) { const cb = modalOnClose; modalOnClose = null; try { cb(); } catch {} }
  if (m.hidden) modalPrevFocus = document.activeElement;
  modalOnClose = typeof onClose === "function" ? onClose : null;
  m.classList.remove("closing");
  m.setAttribute("role", "dialog");
  m.setAttribute("aria-modal", "true");
  sbHideAll();
  m.innerHTML = `<div class="dialog" tabindex="-1">${html}</div>`;
  m.hidden = false;
  const dlg = m.firstElementChild;
  linkLabels(dlg);
  void m.offsetWidth;
  m.classList.add("show");
  const focusTarget = dlg.querySelector("[autofocus]") || dlg.querySelector(FOCUSABLE) || dlg;
  try { focusTarget.focus({ preventScroll: true }); } catch {}
  return dlg;
}

export function closeModal(fireOnClose = true) {
  const m = $("#modal");
  const cb = modalOnClose;
  modalOnClose = null;
  if (fireOnClose && cb) { try { cb(); } catch {} }
  if (!m || m.hidden || m.classList.contains("closing")) return;
  m.classList.remove("show"); m.classList.add("closing");
  clearTimeout(modalT);
  sbHideWithin(m);
  const prev = modalPrevFocus; modalPrevFocus = null;
  modalT = setTimeout(() => {
    m.hidden = true; m.innerHTML = ""; m.classList.remove("closing");
    sbCleanup();
    SB.bars.forEach(b => b.marks.length && sbShow(b));
    if (prev && prev.isConnected && typeof prev.focus === "function") {
      try { prev.focus({ preventScroll: true }); } catch {}
    }
  }, 200);
}

export const NARROW = matchMedia("(max-width: 899px)");
export function navOpen(on) {
  document.body.classList.toggle("nav-open", on);
  const btn = $("#navBtn");
  btn && btn.setAttribute("aria-expanded", on ? "true" : "false");
}

export function hoverFill(box, sel) {
  if (!box) return;
  box.classList.add("hfbox"); box._hfSel = sel;
  if (box._hf) return hfSync(box);
  const st = box._hf = { bg: null, on: false, cur: null, t: 0 };
  const getBg = () => {
    if (!st.bg) { st.bg = document.createElement("i"); st.bg.className = "hf"; }
    if (st.bg.parentNode !== box) box.prepend(st.bg);
    return st.bg;
  };
  const place = (it, slide) => {
    const b = getBg(), br = box.getBoundingClientRect(), r = it.getBoundingClientRect();
    const x = r.left - br.left + box.scrollLeft - box.clientLeft, y = r.top - br.top + box.scrollTop - box.clientTop;
    const pos = `translate(${x}px, ${y}px)`;
    if (!slide) { b.style.transition = "none"; b.style.opacity = "0"; b.style.transform = pos + " scale(.96)"; }
    b.style.width = r.width + "px"; b.style.height = r.height + "px"; b.style.borderRadius = getComputedStyle(it).borderRadius;
    if (!slide) { void b.offsetWidth; b.style.transition = ""; }
    b.style.transform = pos; b.style.opacity = "1";
    st.on = true; st.cur = it;
  };
  const hide = () => { if (st.bg) st.bg.style.opacity = "0"; st.on = false; st.cur = null; };
  box.addEventListener("pointerover", e => {
    if (e.pointerType === "touch") return;
    clearTimeout(st.t);
    const it = e.target.closest(box._hfSel);
    if (!it || !box.contains(it) || it.closest(".hfbox") !== box || it.matches(".on.mi")) { st.t = setTimeout(hide, 80); return; }
    if (it !== st.cur || !st.on) place(it, st.on);
  });
  box.addEventListener("pointerleave", () => { clearTimeout(st.t); hide(); });
  Object.assign(st, { place, hide });
}
export function hfSync(box) {
  const st = box && box._hf; if (!st) return;
  if (st.bg && st.bg.parentNode !== box) box.prepend(st.bg);
  const it = $$(box._hfSel, box).find(x => x.matches(":hover") && !x.matches(".on.mi"));
  it ? st.place(it, st.on) : st.hide();
}

export function tabInd(box, animate) {
  if (!box) return;
  let ind = $(".ind", box);
  if (!ind) { ind = document.createElement("i"); ind.className = "ind"; box.appendChild(ind); }
  const on = $("button.on", box); if (!on) return;
  if (!animate) ind.style.transition = "none";
  ind.style.width = Math.max(0, on.offsetWidth - 24) + "px";
  ind.style.transform = `translateX(${on.offsetLeft + 12}px)`;
  if (!animate) { void ind.offsetWidth; ind.style.transition = ""; }
}

let activePop = null, activePopCloser = null;
export function closePopMenus() {
  const pops = new Set($$(".pop"));
  if (activePop) pops.add(activePop);
  activePop = null;
  if (activePopCloser) { document.removeEventListener("click", activePopCloser); activePopCloser = null; }
  pops.forEach(p => {
    if (!p.isConnected || p.classList.contains("closing")) return;
    p.classList.add("closing");
    setTimeout(() => p.isConnected && p.remove(), 145);
  });
}
export function popMenu(host, html) {
  const wasSame = $$(".pop:not(.closing)", host).length > 0;
  closePopMenus();
  if (wasSame) return null;
  host.insertAdjacentHTML("beforeend", `<div class="pop">${html}</div>`);
  const pop = $$(".pop:not(.closing)", host).pop(); hoverFill(pop, "a");
  if (pop.getBoundingClientRect().left < 8) Object.assign(pop.style, { left: "0", right: "auto", transformOrigin: "top left" });
  activePop = pop;
  const closer = () => closePopMenus();
  activePopCloser = closer;
  setTimeout(() => { if (activePop === pop) document.addEventListener("click", closer, { once: true }); });
  return pop;
}

let cfmResolver = null, cfmT = 0, cfmPrevFocus = null;
function closeConfirm(ok) {
  const el = $("#confirmModal");
  const resolve = cfmResolver; cfmResolver = null;
  if (resolve) resolve(!!ok);
  if (!el || el.hidden || el.classList.contains("closing")) return;
  el.classList.remove("show"); el.classList.add("closing");
  clearTimeout(cfmT);
  const prev = cfmPrevFocus; cfmPrevFocus = null;
  cfmT = setTimeout(() => {
    el.hidden = true; el.textContent = ""; el.classList.remove("closing");
    if (prev && prev.isConnected && typeof prev.focus === "function") {
      try { prev.focus({ preventScroll: true }); } catch {}
    }
  }, 180);
}
export function confirmAction(opts = {}) {
  const cfg = typeof opts === "string" ? { message: opts } : (opts || {});
  const { title = "确认操作", message = "", confirmText = "确定", cancelText = "取消", danger = false } = cfg;
  if (cfmResolver) closeConfirm(false);
  let el = $("#confirmModal");
  if (!el) {
    el = document.createElement("div");
    el.id = "confirmModal";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "cfmTitle");
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener("mousedown", e => { if (e.target === el) closeConfirm(false); });
  }
  clearTimeout(cfmT);
  if (el.hidden) cfmPrevFocus = document.activeElement;
  el.classList.remove("closing");
  el.textContent = "";
  const dlg = document.createElement("div");
  dlg.className = "dialog dialog-sm";
  dlg.tabIndex = -1;
  const h2 = document.createElement("h2");
  h2.id = "cfmTitle";
  h2.textContent = title;
  const p = document.createElement("p");
  p.className = "confirm-msg";
  p.textContent = message;
  const row = document.createElement("div");
  row.className = "row";
  row.style.cssText = "justify-content:flex-end;margin-top:18px;gap:8px";
  const noBtn = document.createElement("button");
  noBtn.type = "button";
  noBtn.id = "cfmNo";
  noBtn.textContent = cancelText;
  const yesBtn = document.createElement("button");
  yesBtn.type = "button";
  yesBtn.id = "cfmYes";
  yesBtn.className = danger ? "rec" : "pri";
  yesBtn.textContent = confirmText;
  noBtn.onclick = () => closeConfirm(false);
  yesBtn.onclick = () => closeConfirm(true);
  row.append(noBtn, yesBtn);
  dlg.append(h2, p, row);
  el.appendChild(dlg);
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add("show");
  const focusBtn = danger ? noBtn : yesBtn;
  try { focusBtn.focus({ preventScroll: true }); } catch {}
  return new Promise(resolve => { cfmResolver = resolve; });
}

const SB_SEL = "#mlist, #main, .pane-body, .tr-scroll, .livebox, .dialog, textarea";
export const SB = { bars: new Map(), layer: null, hover: null, drag: null, input: 0, raf: 0, pt: null, px: 0 };
const sbScrollable = el => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
function sbHideAll() {
  SB.bars.forEach(b => b.node.classList.remove("on", "near"));
}
function sbHideWithin(root) {
  SB.bars.forEach(b => root.contains(b.el) && b.node.classList.remove("on", "near"));
}
function sbFind(t) {
  for (let el = t && t.closest ? t.closest(SB_SEL) : null; el; el = el.parentElement && el.parentElement.closest(SB_SEL))
    if (sbScrollable(el)) return el;
  return null;
}
export function sbCleanup(clearMain = false) {
  const main = clearMain ? $("#main") : null;
  SB.bars.forEach((b, el) => {
    const isMainScope = !!(main && (el === main || main.contains(el)));
    if (!el.isConnected || isMainScope) {
      clearTimeout(b.t);
      if (b.placeRaf) { cancelAnimationFrame(b.placeRaf); b.placeRaf = 0; }
      b.marks = [];
      b.markEl = null;
      b.marksBox.innerHTML = "";
      b.node.classList.remove("on", "near", "drag");
      b.node.remove();
      SB.bars.delete(el);
      if (SB.hover === el) SB.hover = null;
      if (SB.drag === b) SB.drag = null;
      return;
    }
    if (b.marks.length && !(b.markEl && b.markEl.isConnected)) {
      b.marks = []; b.markEl = null; b.marksBox.innerHTML = "";
      if ((SB.hover !== el && SB.drag !== b) || !sbPlace(b)) b.node.classList.remove("on", "near");
    } else if (b.node.classList.contains("on") && !sbPlace(b)) {
      b.node.classList.remove("on", "near");
    }
  });
  if (SB.pt && (!SB.pt.isConnected || (main && (SB.pt === main || main.contains(SB.pt))))) SB.pt = null;
}
export function sbBar(el) {
  let b = SB.bars.get(el);
  if (b) return b;
  sbCleanup();
  if (!SB.layer) { SB.layer = document.createElement("div"); SB.layer.id = "sbLayer"; document.body.appendChild(SB.layer); }
  const node = document.createElement("div"); node.className = "sb";
  node.innerHTML = `<div class="sb-marks"></div><i class="sb-thumb"></i>`;
  SB.layer.appendChild(node);
  b = {
    el, node, thumb: node.lastChild, marksBox: node.firstChild, marks: [], markEl: null, t: 0, h: 0, trackH: 0,
    inset: Math.max(4, (parseFloat(getComputedStyle(el).borderTopRightRadius) || 0) * .6),
  };
  SB.bars.set(el, b);
  b.thumb.addEventListener("pointerdown", e => sbDrag(b, e));
  return b;
}
export function sbPlace(b) {
  const el = b.el;
  if (!el.isConnected) { clearTimeout(b.t); b.node.remove(); SB.bars.delete(el); if (SB.hover === el) SB.hover = null; return false; }
  if (b.marks.length && !(b.markEl && b.markEl.isConnected)) { b.marks = []; b.markEl = null; b.marksBox.innerHTML = ""; }
  const sh = el.scrollHeight, ch = el.clientHeight, r = el.getBoundingClientRect();
  const top = Math.max(r.top + el.clientTop, 0) + b.inset, bot = Math.min(r.top + el.clientTop + ch, innerHeight) - b.inset;
  const trackH = bot - top, ok = sh > ch + 1 && trackH > 40 && r.width > 0;
  b.node.classList.toggle("none", !ok);
  if (!ok) return false;
  const h = Math.max(28, Math.round(trackH * ch / sh)), y = (trackH - h) * Math.min(1, el.scrollTop / (sh - ch));
  b.trackH = trackH; b.h = h;
  b.node.style.cssText = `transform:translate(${r.left + el.clientLeft + el.clientWidth}px,${top}px);height:${trackH}px`;
  b.thumb.style.cssText = `height:${h}px;transform:translateY(${y}px)`;
  return true;
}
export function sbShow(b, hideAfter = 0) {
  clearTimeout(b.t);
  if (!sbPlace(b)) return;
  b.node.classList.add("on");
  if (hideAfter) b.t = setTimeout(() => sbHide(b), hideAfter);
}
export function sbHide(b) {
  if (SB.drag === b || SB.hover === b.el || b.marks.length) return;
  b.node.classList.remove("on", "near");
}
export const sbHideLater = (b, ms = 700) => { clearTimeout(b.t); b.t = setTimeout(() => sbHide(b), ms); };
export function isOverlayOpen() {
  return !!$('[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])');
}

const sbBlocked = el => {
  const dlg = $('[role="dialog"]:not([hidden])');
  return !!(dlg && !dlg.contains(el));
};
function sbFrame() {
  SB.raf = 0;
  if (SB.pt && SB.pt.closest && SB.pt.closest("#sbLayer")) return;
  const el = SB.pt ? sbFind(SB.pt) : null;
  if (el !== SB.hover) {
    const old = SB.hover && SB.bars.get(SB.hover);
    SB.hover = el;
    if (old) { old.node.classList.remove("near"); sbHideLater(old); }
  }
  if (!el || sbBlocked(el)) return;
  const b = sbBar(el); sbShow(b);
  const edge = el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
  b.node.classList.toggle("near", SB.px > edge - 16 && SB.px <= edge + 2);
}
function sbDrag(b, e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const el = b.el, y0 = e.clientY, s0 = el.scrollTop, k = (el.scrollHeight - el.clientHeight) / Math.max(1, b.trackH - b.h);
  const ac = new AbortController();
  SB.drag = b; b.node.classList.add("drag", "on"); b.thumb.setPointerCapture(e.pointerId);
  b.thumb.addEventListener("pointermove", ev => { el.scrollTop = s0 + (ev.clientY - y0) * k; }, { signal: ac.signal });
  const up = () => { ac.abort(); SB.drag = null; b.node.classList.remove("drag"); if (SB.hover !== el) sbHideLater(b); };
  b.thumb.addEventListener("pointerup", up, { signal: ac.signal });
  b.thumb.addEventListener("pointercancel", up, { signal: ac.signal });
}
export function sbMarks(el, hits) {
  if (!el) return;
  const b = sbBar(el), sh = el.scrollHeight || 1, base = el.getBoundingClientRect().top + el.clientTop - el.scrollTop;
  b.marks = hits.map(h => { const r = h.getBoundingClientRect(); return (r.top + r.height / 2 - base) / sh; });
  b.markEl = hits[0] || null;
  b.marksBox.innerHTML = b.marks.map(f => `<i style="top:${(f * 100).toFixed(2)}%"></i>`).join("");
  b.marks.length ? sbShow(b) : SB.hover !== el && sbHideLater(b, 300);
}

export function initGlobalUI() {
  window.addEventListener("unhandledrejection", e => {
    if (e.reason && e.reason.name === "AbortError") return;
    const msg = (e.reason && e.reason.message) || String(e.reason || "");
    if (msg) toast("操作失败：" + msg, 5000);
  });

  if (IN_APP) {
    const bar = document.createElement("div");
    bar.className = "inapp";
    bar.innerHTML = `<span class="grow">现在是在${IN_APP}里打开的：证书提示、录音都可能不正常。请点右上角“…”，选“在浏览器打开”（iPhone 用 Safari）。</span><button class="sm">知道了</button>`;
    bar.querySelector("button").onclick = () => bar.remove();
    document.body.appendChild(bar);
  }

  const m = $("#modal");
  m.addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
  m.addEventListener("click", e => { if (e.target.closest("[data-close-modal]")) closeModal(); });

  document.addEventListener("keydown", e => {
    const cfm = $("#confirmModal");
    if (cfm && !cfm.hidden && !cfm.classList.contains("closing")) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(false); return; }
      if (e.key === "Tab") {
        const dlg = cfm.firstElementChild; if (!dlg) return;
        const list = $$(FOCUSABLE, dlg).filter(el => el.offsetParent !== null || el === document.activeElement);
        if (!list.length) { e.preventDefault(); dlg.focus(); return; }
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !dlg.contains(document.activeElement))) {
          e.preventDefault(); first.focus();
        }
      }
      return;
    }
    if (e.key === "Escape") {
      if (activePop) { closePopMenus(); return; }
      if (!m.hidden && !e.target.closest(".pe-text")) closeModal();
      else if (document.body.classList.contains("nav-open")) navOpen(false);
      return;
    }
    if (e.key === "Tab" && !m.hidden && !m.classList.contains("closing")) {
      const dlg = m.firstElementChild; if (!dlg) return;
      const list = $$(FOCUSABLE, dlg).filter(el => el.offsetParent !== null || el === document.activeElement);
      if (!list.length) { e.preventDefault(); dlg.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !dlg.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    }
  });

  document.addEventListener("touchstart", () => {}, { passive: true }); // iOS Safari :active 生效

  NARROW.addEventListener("change", () => navOpen(false));
  $("#navBtn").onclick = () => navOpen(!document.body.classList.contains("nav-open"));
  $("#scrim").onclick = () => navOpen(false);
  $("#side").addEventListener("click", e => {
    if (NARROW.matches && e.target.closest("a[href], #newBtn, #settingsBtn, #recPill")) navOpen(false);
  });
  {
    const side = $("#side"), scrim = $("#scrim");
    let x0 = null, y0 = 0, t0 = 0, dx = 0, lock = null;
    const clearDrag = () => {
      side.style.transition = ""; side.style.transform = "";
      if (scrim) { scrim.style.transition = ""; scrim.style.opacity = ""; }
      x0 = null; dx = 0; lock = null;
    };
    side.addEventListener("touchstart", e => {
      if (!NARROW.matches || !document.body.classList.contains("nav-open") || e.touches.length !== 1) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = performance.now(); dx = 0; lock = null;
    }, { passive: true });
    side.addEventListener("touchmove", e => {
      if (x0 === null || e.touches.length !== 1) return;
      const curX = e.touches[0].clientX - x0, curY = e.touches[0].clientY - y0;
      if (lock === null) {
        if (Math.abs(curX) < 8 && Math.abs(curY) < 8) return;
        lock = curX < 0 && Math.abs(curX) > Math.abs(curY) ? "h" : "v";
      }
      if (lock !== "h") return;
      dx = Math.min(0, curX);
      side.style.transition = "none";
      side.style.transform = `translate3d(${dx}px, 0, 0)`;
      if (scrim) {
        const w = Math.max(1, side.offsetWidth || 280);
        scrim.style.transition = "none";
        scrim.style.opacity = String(Math.max(0, 1 + dx / w));
      }
    }, { passive: true });
    const endSwipe = () => {
      if (x0 === null) return;
      const dt = Math.max(1, performance.now() - t0);
      const vx = dx / dt;
      const shouldClose = lock === "h" && (dx < -72 || (dx < -24 && vx < -0.45));
      clearDrag();
      if (shouldClose) navOpen(false);
    };
    side.addEventListener("touchend", endSwipe, { passive: true });
    side.addEventListener("touchcancel", clearDrag, { passive: true });
  }

  document.addEventListener("pointermove", e => {
    if (e.pointerType === "touch" || SB.drag) return;
    SB.pt = e.target; SB.px = e.clientX;
    if (!SB.raf) SB.raf = requestAnimationFrame(sbFrame);
  }, { passive: true });
  document.addEventListener("pointerout", e => { if (!e.relatedTarget && !SB.drag) { SB.pt = null; sbFrame(); } });
  document.addEventListener("scroll", e => {
    const el = e.target;
    if (!(el instanceof Element) || !el.matches(SB_SEL)) return;
    const b = SB.bars.get(el);
    if (b && b.node.classList.contains("on")) {
      if (!b.placeRaf) {
        b.placeRaf = requestAnimationFrame(() => {
          b.placeRaf = 0;
          sbPlace(b);
        });
      }
      if (SB.hover !== el && !SB.drag) sbHideLater(b, 900);
    } else if (performance.now() - SB.input < 600 && !sbBlocked(el)) {
      sbShow(sbBar(el), SB.hover === el ? 0 : 900);
    }
  }, { capture: true, passive: true });
  ["wheel", "touchmove", "keydown"].forEach(t => addEventListener(t, () => { SB.input = performance.now(); }, { capture: true, passive: true }));
  addEventListener("resize", () => SB.bars.forEach(b => b.node.classList.contains("on") && sbPlace(b)));
}
