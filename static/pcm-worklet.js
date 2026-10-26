// 把任意采样率的输入重采样为 16kHz 单声道 Int16，每 100ms 发送一次，并附带音量电平。
// 先用加窗 sinc FIR 低通（截止 7.2kHz）抗混叠，再线性插值降采样。
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
    this.hist = new Float32Array(N - 1); // 上一块的尾部，用于跨块卷积
    this.t = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.peak = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    // 多声道取平均
    const len = input[0].length;
    const raw = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) raw[i] += ch[i] / input.length;
    }
    // FIR 低通
    const h = this.h, H = h.length, P = H - 1;
    const ext = new Float32Array(P + len);
    ext.set(this.hist, 0); ext.set(raw, P);
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let k = 0; k < H; k++) acc += h[k] * ext[i + P - k];
      x[i] = acc;
    }
    if (P) this.hist = ext.slice(len);
    let t = this.t;
    while (t < len) {
      const i = Math.floor(t), f = t - i;
      const a = x[i], b = i + 1 < len ? x[i + 1] : x[i];
      let v = a + (b - a) * f;
      v = Math.max(-1, Math.min(1, v));
      const av = Math.abs(v);
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
