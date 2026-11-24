// HTTP API、NDJSON 流式读取与设置加载（支持超时与 AbortSignal）
import { OFFLINE, S } from "./utils.js";

// 局域网设备的登录过期了（或者在电脑上点了“让所有设备退出”）：回登录页，登录后回到当前页面
export function needLogin(status, data) {
  if (status !== 401 || !data || !data.login) return false;
  location.href = data.login + "?next=" + encodeURIComponent("/" + location.hash);
  return true;
}

export async function api(url, opt = {}) {
  const { timeout = 30000, signal: extSignal, ...rest } = opt;
  const o = { ...rest };
  if (o.body && typeof o.body !== "string" && !(o.body instanceof FormData)) {
    o.body = JSON.stringify(o.body);
    o.headers = { "Content-Type": "application/json", ...(o.headers || {}) };
  }
  let ac = null, timer = null, timedOut = false, onExtAbort = null;
  if (timeout > 0 || extSignal) {
    ac = new AbortController();
    o.signal = ac.signal;
    if (extSignal) {
      if (extSignal.aborted) ac.abort(extSignal.reason);
      else { onExtAbort = () => ac.abort(extSignal.reason); extSignal.addEventListener("abort", onExtAbort, { once: true }); }
    }
    if (timeout > 0) timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeout);
  }
  let r;
  try {
    r = await fetch(url, o);
  } catch (e) {
    if (timedOut) throw new Error("请求超时，请检查电脑上的会议记录服务");
    if (extSignal && extSignal.aborted) throw e;
    throw new Error(OFFLINE);
  } finally {
    clearTimeout(timer);
    if (extSignal && onExtAbort) extSignal.removeEventListener("abort", onExtAbort);
  }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
  if (needLogin(r.status, data)) throw new Error("需要重新登录");
  if (!r.ok) throw new Error((data && data.detail) || `${r.status} ${r.statusText}`);
  return data;
}

export async function streamNd(url, body, onEvent, opt = {}) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opt.signal,
    });
  } catch (e) {
    if (opt.signal && opt.signal.aborted) throw e;
    throw new Error(OFFLINE);
  }
  if (!r.ok) {
    let j = null; try { j = await r.json(); } catch {}
    if (needLogin(r.status, j)) throw new Error("需要重新登录");
    throw new Error((j && j.detail) || r.statusText);
  }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  const take = chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  };
  for (;;) {
    const { value, done } = await rd.read();
    if (done) {
      take(dec.decode());
      if (buf.trim()) onEvent(JSON.parse(buf));
      break;
    }
    take(dec.decode(value, { stream: true }));
  }
}

let settingsPromise = null;
export async function ensureSettings() {
  if (S.settings) return S.settings;
  if (!settingsPromise) {
    settingsPromise = api("/api/settings").then(s => { S.settings = s; return s; })
      .finally(() => { settingsPromise = null; });
  }
  return settingsPromise;
}
