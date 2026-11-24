// 离线测 static/pcm-worklet.js（浏览器里把麦克风声音降到 16kHz 的那段代码）：
//   1) 样本数：输入 N 秒，输出必须正好 N×16000 个样本（差 ≤ 1），长时间录音才不会和真实时间对不上
//   2) 通带：1kHz、3.4kHz 正弦波降采样后幅度不变（±0.5dB），频率不变
//   3) 抗混叠：高于 8kHz 的声音（12kHz、15kHz）必须被压掉（≤ -40dB），否则会折叠成假的低频噪声
// 用法：node tests/audio/resampler.mjs
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../../static/pcm-worklet.js", import.meta.url), "utf8");
function makeProc(rate) {
  let Cls;
  const posted = [];
  const ctx = { sampleRate: rate, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => posted.push(m) }; } },
    registerProcessor: (_, c) => { Cls = c; }, currentFrame: 0, Math, Float32Array, Int16Array };
  vm.runInNewContext(src, ctx);
  return { p: new Cls(), posted };
}
function run(rate, seconds, gen) {
  const { p, posted } = makeProc(rate);
  const total = Math.round(rate * seconds);
  for (let i = 0; i < total; i += 128) {
    const n = Math.min(128, total - i), ch = new Float32Array(n);
    for (let k = 0; k < n; k++) ch[k] = gen((i + k) / rate);
    p.process([[ch]]);
  }
  const out = [];
  for (const m of posted) out.push(...new Int16Array(m.pcm));
  // 最后不满 100ms 的一块还在缓冲里
  for (let i = 0; i < p.n; i++) out.push(p.out[i]);
  return Float64Array.from(out, v => v / 32768);
}
// 单频幅度（Goertzel），跳过开头 0.1 秒的滤波器暖机
function amp(x, f, sr = 16000) {
  const s = x.subarray(Math.round(sr * 0.1)), w = 2 * Math.PI * f / sr;
  let re = 0, im = 0;
  for (let n = 0; n < s.length; n++) { re += s[n] * Math.cos(w * n); im -= s[n] * Math.sin(w * n); }
  return 2 * Math.hypot(re, im) / s.length;
}
const db = v => 20 * Math.log10(Math.max(v, 1e-12));
const dbs = v => v < 1 / 32768 ? "低于 16 位量化（输出全是 0）" : db(v).toFixed(1) + " dB";
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "通过" : "失败"}  ${msg}`); if (!ok) fail++; };

for (const rate of [48000, 44100, 24000, 16000]) {
  console.log(`\n--- 设备采样率 ${rate} Hz ---`);
  const secs = rate === 44100 ? 600 : 60; // 44.1kHz 的比例不是整数，测 10 分钟看累计误差
  const n = run(rate, secs, () => 0).length;
  check(Math.abs(n - secs * 16000) <= 1, `${secs} 秒 → ${n} 个样本（应为 ${secs * 16000}，误差 ${n - secs * 16000}）`);
  for (const f of [1000, 3400]) {
    const y = run(rate, 2, t => 0.5 * Math.sin(2 * Math.PI * f * t));
    const a = amp(y, f);
    check(Math.abs(db(a / 0.5)) <= 0.5, `${f}Hz 通带增益 ${db(a / 0.5).toFixed(2)} dB`);
  }
  if (rate > 16000) {
    for (const f of [9000, 12000, 15000].filter(f => f < rate / 2)) {
      const y = run(rate, 2, t => 0.5 * Math.sin(2 * Math.PI * f * t));
      const alias = Math.abs(16000 - f); // 折叠到的频率
      const a = amp(y, alias);
      check(db(a / 0.5) <= -40, `${f}Hz 输入折叠到 ${alias}Hz 的残留 ${dbs(a / 0.5)}（要 ≤ -40dB）`);
    }
  }
}
console.log("\n--- 额外回归：多声道平均 & 变长音频块 & 缓冲复用 ---");
{
  const { p, posted } = makeProc(48000);
  const ext0 = p.ext, x0 = p.x;
  const total = 48000 * 2;
  for (let i = 0; i < total; i += 128) {
    const n = Math.min(128, total - i), c0 = new Float32Array(n), c1 = new Float32Array(n);
    for (let k = 0; k < n; k++) { const s = 0.6 * Math.sin(2 * Math.PI * 1000 * (i + k) / 48000); c0[k] = s; c1[k] = s * 0.5; }
    p.process([[c0, c1]]);
  }
  const out = []; for (const m of posted) out.push(...new Int16Array(m.pcm));
  for (let i = 0; i < p.n; i++) out.push(p.out[i]);
  const a = amp(Float64Array.from(out, v => v / 32768), 1000);
  check(p.ext === ext0 && p.x === x0, "128 样本块全程复用预分配缓冲（零重建）");
  check(Math.abs(db(a / 0.45)) <= 0.5, `双声道平均增益 ${db(a / 0.45).toFixed(2)} dB（应接近 0dB）`);
}
{
  const { p, posted } = makeProc(44100);
  const sizes = [64, 256, 33, 128, 300];
  let idx = 0, si = 0, total = 44100 * 2;
  while (idx < total) {
    const n = Math.min(sizes[si++ % sizes.length], total - idx), ch = new Float32Array(n);
    for (let k = 0; k < n; k++) ch[k] = 0.5 * Math.sin(2 * Math.PI * 1000 * (idx + k) / 44100);
    p.process([[ch]]);
    idx += n;
  }
  const out = []; for (const m of posted) out.push(...new Int16Array(m.pcm));
  for (let i = 0; i < p.n; i++) out.push(p.out[i]);
  const a = amp(Float64Array.from(out, v => v / 32768), 1000);
  check(Math.abs(out.length - 32000) <= 1, `变长块 2 秒 → ${out.length} 个样本（应为 32000）`);
  check(Math.abs(db(a / 0.5)) <= 0.5, `变长块 1kHz 通带增益 ${db(a / 0.5).toFixed(2)} dB`);
}
console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
