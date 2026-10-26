// 浏览器里的录音续接测试：真 Chromium + 假麦克风（播放一段真实会议录音），中间放一个可以“拔网线”的代理。
//   1. 断网 12 秒（连接被重置）：录音不停，声音存在页面里，连上后补传
//   2. 黑洞 10 秒（连接没断但数据不通，浏览器察觉不到）：8 秒没确认就主动重连
//   3. 主线程卡 4 秒（消息晚到）：不能误报“没录到”
//   4. 声音处理被挂起 5 秒（相当于来电打断）：必须记一个约 5 秒的缺口
//   5. 断网时点“结束录音”：显示“正在把剩下的录音传到电脑”，连上后传完再结束
// 最后核对：页面产生的字节 =电脑收到的字节 = pcm 文件里这次录音的字节；健康记录里重连次数、缺口都对。
// 用法：MN_URL=http://127.0.0.1:8772 MN_WAV=/tmp/speech.wav node rec-resume.mjs
import { chromium } from "@playwright/test";
import net from "node:net";
import fs from "node:fs";

const UP = new URL(process.env.MN_URL || "http://127.0.0.1:8772");
const WAV = process.env.MN_WAV;
const DATA = process.env.MN_DATA; // 服务的数据目录（核对 pcm）
const PORT = 18000 + Math.floor(Math.random() * 1000);
let mode = "up"; // up | reset | hole
const conns = new Set();
const proxy = net.createServer(c => {
  if (mode !== "up") return c.destroy();
  const u = net.connect(+UP.port, UP.hostname);
  const pair = { c, u, held: [] };
  conns.add(pair);
  const fwd = (from, to, dir) => from.on("data", b => { if (mode === "hole" && pair.hole) pair.held.push([to, b]); else to.write(b); });
  fwd(c, u); fwd(u, c);
  const end = () => { c.destroy(); u.destroy(); conns.delete(pair); };
  for (const s of [c, u]) { s.on("error", end); s.on("close", end); }
}).listen(PORT);
const cut = ms => { mode = "reset"; for (const p of conns) { p.c.destroy(); p.u.destroy(); } setTimeout(() => { mode = "up"; }, ms); };
const hole = ms => {
  mode = "hole"; for (const p of conns) p.hole = true;
  setTimeout(() => { mode = "up"; for (const p of conns) { p.hole = false; for (const [to, b] of p.held) to.write(b); p.held = []; } }, ms);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "通过" : "失败"}  ${msg}`); if (!ok) fail++; };

// --disable-audio-output：用假的音频输出时钟（无头浏览器在电脑锁屏时拿不到系统音频输出，AudioContext 时钟不走）
const browser = await chromium.launch({ args: ["--disable-audio-output", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(WAV ? [`--use-file-for-fake-audio-capture=${WAV}`] : []), "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on("pageerror", e => { console.log("页面报错：", e.message); fail++; });
await page.goto(`http://127.0.0.1:${PORT}/#/`, { waitUntil: "networkidle" });
await page.fill("#fTitle", "录音续接测试 " + new Date().toTimeString().slice(0, 8));
await page.click("#startBtn");
await page.waitForFunction(() => REC.active && REC.next > 10, null, { timeout: 30000 });
const mid = await page.evaluate(() => REC.mid);
const st = () => page.evaluate(() => ({ conn: REC.conn, next: REC.next, base: REC.base, sent: REC.sent, gaps: REC.gaps.map(g => ({ ...g })), dropped: REC.dropped,
  banner: (document.querySelector("#lostSlot") || {}).innerText || "", elapsed: REC.elapsedMs() }));
const allAcked = async (t = 20000) => { await page.waitForFunction(() => REC.conn === "ok" && REC.base === REC.next, null, { timeout: t, polling: 200 }); };
await sleep(6000);

// 1. 断网 12 秒
cut(12000);
await sleep(2500);
let s = await st();
check(s.conn === "reconnecting" && /连接断开/.test(s.banner), `断网 2.5 秒后：状态 ${s.conn}，提示“${s.banner.split("\n")[0]}”`);
await sleep(7000);
s = await st();
check(s.next - s.base >= 80, `断网期间录音继续，页面里暂存了 ${((s.next - s.base) / 10).toFixed(1)} 秒`);
await allAcked();
s = await st();
check(s.base === s.next && s.conn === "ok", `恢复后自动重连并补传完（${s.next} 块全部确认）`);

// 2. 黑洞 10 秒
await sleep(3000);
const t0 = Date.now();
hole(10000);
await page.waitForFunction(() => REC.conn === "reconnecting", null, { timeout: 15000 });
check(Date.now() - t0 < 10500, `黑洞：${((Date.now() - t0) / 1000).toFixed(1)} 秒后察觉连接假活并主动重连`);
await allAcked(25000);
s = await st();
check(s.base === s.next, `黑洞恢复后补传完（${s.next} 块）`);

// 3. 主线程卡 3 秒：不能误报缺口
const g0 = (await st()).gaps.length;
await page.evaluate(() => { const t = Date.now(); while (Date.now() - t < 4000) {} });
await sleep(4000);
s = await st();
check(s.gaps.length === g0, `主线程卡 4 秒（消息晚到）：缺口数 ${g0} → ${s.gaps.length}（应不变）`);

// 4. 声音处理挂起 5 秒（来电打断）
await page.evaluate(() => REC.ctx.suspend());
await sleep(5000);
await page.evaluate(() => REC.ctx.resume());
await sleep(3500);
s = await st();
const g = s.gaps[s.gaps.length - 1];
check(s.gaps.length === g0 + 1 && g && Math.abs(g.dur_ms - 5000) < 800 && g.reason === "interrupted", `挂起 5 秒：记了缺口 ${g ? `${g.dur_ms}ms，原因 ${g.reason}` : "无（" + JSON.stringify(await page.evaluate(() => REC.clock)) + "）"}`);

// 5. 断网时点结束
await sleep(2000);
cut(6000);
await sleep(300);
const produced = await page.evaluate(() => REC.next * 3200 + REC.dropped);
await page.click("#rStop");
await sleep(1500);
const ban = await page.evaluate(() => (document.querySelector("#lostSlot") || {}).innerText || "");
check(/正在把剩下的录音传到电脑/.test(ban), `断网时结束：提示“${ban.split("\n")[0]}”`);
await page.waitForFunction(() => !REC.active && !REC.stopping, null, { timeout: 30000 });
const finalProduced = await page.evaluate(() => REC.next * 3200 + REC.dropped);
await sleep(1500);

const m = await (await fetch(`${UP.origin}/api/meetings/${mid}`)).json();
const h = (m.meta.rec_health || []).at(-1) || {};
check(h.end === "stop", `录音正常结束（end=${h.end}）`);
check(h.received === finalProduced && h.produced === finalProduced, `字节对账：页面产生 ${finalProduced}，电脑收到 ${h.received}，页面上报 ${h.produced}`);
check(h.reconnects >= 3, `重连 ${h.reconnects} 次`);
check((h.gaps || []).length === 1 && h.gaps[0].reason === "interrupted", `电脑记下的缺口：${JSON.stringify(h.gaps)}`);
if (DATA) {
  const size = fs.statSync(`${DATA}/meetings/${mid}/audio.pcm`).size;
  check(size === h.start_bytes + finalProduced, `pcm 文件 ${size} 字节 = 起点 ${h.start_bytes} + 本次 ${finalProduced}`);
}
console.log(`\n会议 ${mid}，录了 ${(finalProduced / 32000).toFixed(1)} 秒音频（结束前已产生 ${(produced / 32000).toFixed(1)} 秒）`);
await browser.close();
proxy.close();
console.log(fail ? `${fail} 项失败` : "全部通过");
process.exit(fail ? 1 : 0);
