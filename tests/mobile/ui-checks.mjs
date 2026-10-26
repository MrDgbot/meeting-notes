// 界面上的几处闭环检查（WebKit，手机尺寸）：
//   1. 微信 / 飞书里打开：应用和登录页都提示换浏览器
//   2. 弹窗开着时按返回（安卓返回手势）：弹窗关掉
//   3. 有缺口的录音：会议头部显示“录音有 N 处缺口”，转写稿里标出位置
//   4. 录音设备断线等重连：别的设备上看到提示，能“现在结束”
// 用法：MN_URL=http://127.0.0.1:8772 MN_LAN=https://<IP>:8773 node ui-checks.mjs
import { webkit } from "@playwright/test";
const U = process.env.MN_URL || "http://127.0.0.1:8772", LAN = process.env.MN_LAN;
const WX = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323d) NetType/WIFI Language/zh_CN";
const FS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.30.0 LarkLocale/zh_CN";
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "通过" : "失败"}  ${msg}`); if (!ok) fail++; };
const b = await webkit.launch();
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true };

for (const [name, ua] of [["微信", WX], ["飞书", FS]]) {
  const p = await (await b.newContext({ ...phone, userAgent: ua })).newPage();
  await p.goto(U + "/#/", { waitUntil: "networkidle" });
  const t = await p.locator(".inapp").innerText().catch(() => "");
  check(t.includes(name) && t.includes("在浏览器打开"), `${name}里打开应用：${t.slice(0, 30)}…`);
  if (LAN) {
    await p.goto(LAN + "/lan/login", { waitUntil: "load" });
    const t2 = await p.locator("#inapp").innerText().catch(() => "");
    check(t2.includes(name), `${name}里打开登录页：${t2.slice(0, 30)}…`);
  }
  await p.context().close();
}
{
  const p = await (await b.newContext(phone)).newPage();
  await p.goto(U + "/#/", { waitUntil: "networkidle" });
  check(!(await p.locator(".inapp").count()), "Safari 里打开：不显示应用内置浏览器提示");
  const metas = await (await fetch(U + "/api/meetings")).json();
  await p.goto(U + "/#/m/" + metas[0].id, { waitUntil: "networkidle" });
  await p.evaluate(() => openSettings()); await p.waitForTimeout(600);
  await p.goBack(); await p.waitForTimeout(800);
  check(await p.evaluate(() => $("#modal").hidden), "设置弹窗开着时后退：弹窗关掉了");

  // 有缺口、已转写的录音
  const withGap = [];
  for (const m of metas.slice(0, 30)) { const d = await (await fetch(U + "/api/meetings/" + m.id)).json(); if ((d.meta.rec_health || []).some(h => (h.gaps || []).length) && d.transcript) withGap.push(m.id); }
  if (withGap.length) {
    await p.goto(U + "/#/m/" + withGap[0], { waitUntil: "networkidle" }); await p.waitForTimeout(600);
    const rh = await p.locator(".meta-line .rh").innerText().catch(() => "");
    check(/缺口/.test(rh), `有缺口的会议头部：“${rh}”`);
    if (await p.locator("button[data-tab=transcript]").count()) await p.click("button[data-tab=transcript]");
    await p.waitForTimeout(400);
    const gm = await p.locator(".gapmark").first().innerText().catch(() => "");
    check(/没录到/.test(gm), `转写稿里的缺口标记：“${gm}”`);
  } else check(false, "没找到有缺口且已转写的会议（先跑 rec-resume.mjs）");

  // 断线等重连中的录音
  let rc = null;
  for (const m of metas.slice(0, 30)) { const d = await (await fetch(U + "/api/meetings/" + m.id)).json(); if (d.live_state && d.live_state.state === "reconnecting") { rc = m.id; break; } }
  if (rc) {
    await p.goto(U + "/#/m/" + rc, { waitUntil: "networkidle" }); await p.waitForTimeout(600);
    const bt = await p.locator(".banner.warn").first().innerText().catch(() => "");
    check(/正在等它连回来/.test(bt), `别的设备看到断线提示：“${bt.slice(0, 40)}…”`);
    await p.click("#liveEnd"); await p.waitForTimeout(2500);
    const d = await (await fetch(U + "/api/meetings/" + rc)).json();
    check(!d.live_active && ["queued", "transcribing", "ready", "new"].includes(d.meta.status), `点“现在结束”后：录音收尾，状态 ${d.meta.status}`);
  } else console.log("跳过  没有断线等重连中的录音");
  await p.context().close();
}
await b.close();
console.log(fail ? `${fail} 项失败` : "全部通过");
process.exit(fail ? 1 : 0);
