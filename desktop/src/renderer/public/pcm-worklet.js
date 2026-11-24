// 把任意采样率的输入重采样为 16kHz 单声道 Int16，每 100ms 发送一次，并附带音量电平。
// 先用加窗 sinc FIR 低通（截止 7.2kHz）抗混叠，再线性插值降采样。
// 所有音频线程缓冲在构造函数里预分配并复用，避免每 2.67ms 音频量子产生 GC 抖动。
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    const N = this.ratio > 1.01 ? 63 : 1, fc = 7200 / sampleRate, h = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const k = i - (N - 1) / 2;
      const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
      const win = N === 1 ? 1 : 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (N - 1));
      h[i] = sinc * win; sum += h[i];
    }
    for (let i = 0; i < N; i++) h[i] /= sum;
    this.h = h;
    this.P = N - 1;
    this.hist = new Float32Array(this.P); // 上一块的尾部，用于跨块卷积
    this.cap = 128;
    this.ext = new Float32Array(this.P + this.cap); // [hist | current mono input]
    this.x = new Float32Array(this.cap + 1); // [prevX | current filtered samples]，用于跨块线性插值
    this.prevX = 0;
    this.t = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.peak = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const len = input[0].length;
    if (!len) return true;
    const h = this.h, H = h.length, P = this.P;
    if (len > this.cap) {
      this.cap = len;
      this.ext = new Float32Array(P + len);
      this.x = new Float32Array(len + 1);
    }
    const ext = this.ext, hist = this.hist, x = this.x;
    for (let i = 0; i < P; i++) ext[i] = hist[i];
    // 单声道直拷，多声道取平均（直接写入 ext 后半段，无临时分配）
    if (input.length === 1) {
      const ch = input[0];
      for (let i = 0; i < len; i++) ext[P + i] = ch[i];
    } else {
      const inv = 1 / input.length;
      const ch0 = input[0];
      for (let i = 0; i < len; i++) ext[P + i] = ch0[i] * inv;
      for (let c = 1; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < len; i++) ext[P + i] += ch[i] * inv;
      }
    }
    // FIR 低通（x[0] 保留上一块末样本以平滑跨块线性插值）
    x[0] = this.prevX;
    if (P) {
      for (let i = 0; i < len; i++) {
        let acc = 0;
        const base = i + P;
        for (let k = 0; k < H; k++) acc += h[k] * ext[base - k];
        x[i + 1] = acc;
      }
      for (let i = 0; i < P; i++) hist[i] = ext[len + i];
    } else {
      for (let i = 0; i < len; i++) x[i + 1] = ext[i];
    }
    this.prevX = x[len];
    let t = this.t;
    while (t < len) {
      const i = Math.floor(t), f = t - i;
      const a = x[i], b = x[i + 1];
      let v = a + (b - a) * f;
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      const av = v < 0 ? -v : v;
      if (av > this.peak) this.peak = av;
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        // frame：音频时钟（这一块结束时的采样帧号）。被系统打断时音频时钟会停，网页拿它和真实时间比，算出没录到的那段
        this.port.postMessage({ pcm: this.out.buffer, level: this.peak, frame: currentFrame + i, rate: sampleRate }, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
        this.peak = 0;
      }
      t += this.ratio;
    }
    this.t = t - len;
    return true;
  }
}
registerProcessor("pcm16k", Pcm16k);
