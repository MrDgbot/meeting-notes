"""第 3 项第二轮 · 方法 C：目标说话人提取（REAL-TSE 挑战赛 WeSep BSRNN 基线的 Core ML 版，ferdinandl007/REAL-TSE-BSRNN-CoreML）。

每处重叠片段，给两个人各取一段“登记音”（同一场会里这个人单独说话的片段，不和别人重叠、离 20 处片段 5 秒以外，
最长的几段拼到 ≤15 秒），用它的声纹从混合音里提出这个人的声音，存成 wav，再由 round2_tse_score.py 交给 Nano。

  tests/eval/.venv-tse/bin/python tests/eval/overlap/round2_tse_extract.py [ref|pya]

ref = 两个人和登记音都按参考标注（作弊：知道是谁、知道谁单独说话）；
pya = 按 pyannote（含重叠）系统输出：窗口里时间最多的两个系统说话人，登记音取他们在系统输出里的单独说话段。
前后处理按模型卡：16k 单声道；STFT 512 点周期汉宁窗、步长 128、居中反射补边；8 秒一块；登记音 80 维 Kaldi fbank（减均值，同 WeSpeaker）。
"""
import json, sys, time
from pathlib import Path
import numpy as np, soundfile as sf, torch, torchaudio.compliance.kaldi as kaldi
import coremltools as ct

sys.path.insert(0, str(Path(__file__).resolve().parent))
import round2_common as C  # noqa: E402

M = C.OUT / "realtse"  # 从 HF 缓存复制出来的 .mlmodelc（缓存里是软链接，Core ML 编译时找不到权重）
emb_m = ct.models.CompiledMLModel(str(M / "BSRNNSpeakerEmbedding.mlmodelc"), compute_units=ct.ComputeUnit.CPU_ONLY)
sep_m = ct.models.CompiledMLModel(str(M / "BSRNNSeparator8s.mlmodelc"), compute_units=ct.ComputeUnit.CPU_ONLY)
CH, NFFT, HOP = 128000, 512, 128
WIN = torch.hann_window(NFFT, periodic=True)


def embed(x: np.ndarray) -> np.ndarray:
    f = kaldi.fbank(torch.from_numpy(x)[None] * (1 << 15), num_mel_bins=80, frame_length=25, frame_shift=10,
                    dither=0.0, sample_frequency=16000, window_type="hamming", energy_floor=0.0)
    f = (f - f.mean(0, keepdim=True))[:1600]
    return emb_m.predict({"fbank": f[None].numpy().astype(np.float16)})["speaker_embedding"]


def extract_chunk(x: np.ndarray, e: np.ndarray) -> np.ndarray:
    n = len(x)
    x = np.pad(x, (0, CH - n))
    S = torch.stft(torch.from_numpy(x), NFFT, HOP, window=WIN, center=True, pad_mode="reflect", return_complex=True)
    ri = torch.stack([S.real, S.imag])[None].numpy().astype(np.float16)
    y = sep_m.predict({"spectrum_ri": ri, "speaker_embedding": e})["estimated_spectrum_ri"].astype(np.float32)
    Y = torch.complex(torch.from_numpy(y[0, 0]), torch.from_numpy(y[0, 1]))
    return torch.istft(Y, NFFT, HOP, window=WIN, center=True, length=CH).numpy()[:n]


def extract(x: np.ndarray, e: np.ndarray) -> np.ndarray:
    """长于 8 秒的按 8 秒一块、重叠 2 秒交叉淡化拼接。"""
    if len(x) <= CH:
        return extract_chunk(x, e)
    step = CH - 32000
    starts = list(range(0, len(x) - CH, step)) + [len(x) - CH]
    acc, w = np.zeros(len(x)), np.zeros(len(x))
    fade = np.ones(CH); fade[:32000] = np.linspace(0, 1, 32000); fade[-32000:] = np.linspace(1, 0, 32000)
    for s in starts:
        acc[s:s + CH] += extract_chunk(x[s:s + CH], e) * fade; w[s:s + CH] += fade
    return (acc / np.maximum(w, 1e-3)).astype(np.float32)


def solo(turns, windows, spk):
    """这个人单独说话的时间段（去掉和别人重叠的部分、20 处片段前后 5 秒），长于 0.5 秒，按长短排。"""
    res = []
    for s, a, b in turns:
        if s != spk:
            continue
        cuts = [(a, b)]
        for s2, a2, b2 in turns:
            if s2 != spk and b2 > a and a2 < b:
                cuts = [p for c in cuts for p in ((c[0], min(c[1], a2)), (max(c[0], b2), c[1])) if p[1] > p[0]]
        for lo, hi in windows:
            cuts = [p for c in cuts for p in ((c[0], min(c[1], lo - 5)), (max(c[0], hi + 5), c[1])) if p[1] > p[0]]
        res += [c for c in cuts if c[1] - c[0] > 0.5]
    return sorted(res, key=lambda c: c[0] - c[1])



def main(mode):
    out = C.OUT / f"tse-{mode}"; out.mkdir(exist_ok=True)
    global t_enroll, t_sep
    ms = C.meta()
    wavs, meta_out = {}, []
    t_enroll = t_sep = 0.0
    for m in ms:
        s = m["session"]
        if s not in wavs:
            wavs[s] = sf.read(C.D / "wav" / f"{s}.wav", dtype="float32")[0]
        wav = wavs[s]
        if mode == "ref":
            turns = [(r[0], r[1], r[2]) for r in C.stm(C.D / "ref" / f"{s}.stm")]
            spks = [m["spkA"], m["spkB"]]
        else:
            turns = C.rttm(Path.home() / f"eval-out/pya/eval/{s}.ovl.rttm")
            dur = {}
            for spk, a, b in turns:
                d = min(b, m["hi"]) - max(a, m["lo"])
                if d > 0:
                    dur[spk] = dur.get(spk, 0) + d
            spks = [k for k, v in sorted(dur.items(), key=lambda kv: -kv[1]) if v >= 0.3][:2]
        wins = [(x["lo"], x["hi"]) for x in ms if x["session"] == s]
        x = wav[int(m["lo"] * 16000):int(m["hi"] * 16000)]
        info = {"k": m["k"], "spks": spks, "enroll_s": [], "dur_in_win": []}
        for j, spk in enumerate(spks):
            t = time.time()
            segs, enr = solo(turns, wins, spk), []
            for a, b in segs:
                enr.append(wav[int(a * 16000):int(b * 16000)])
                if sum(map(len, enr)) >= 15 * 16000:
                    break
            enr = np.concatenate(enr)[:15 * 16000]
            e = embed(enr)
            t_enroll += time.time() - t
            t = time.time()
            y = extract(x, e)
            t_sep += time.time() - t
            sf.write(out / f"{m['k']:02d}_t{j}.wav", (y / (np.abs(y).max() + 1e-9) * 0.5).astype(np.float32), 16000)
            np.save(out / f"{m['k']:02d}_e{j}.npy", e.astype(np.float32))
            info["enroll_s"].append(round(len(enr) / 16000, 1))
            tt = [(a, b) for sp, a, b in turns if sp == spk]
            info["dur_in_win"].append(round(sum(max(0, min(b, m["hi"]) - max(a, m["lo"])) for a, b in tt), 2))
        meta_out.append(info)
        print(m["k"], info, flush=True)
    (out / "meta.json").write_text(json.dumps({"rows": meta_out, "enroll_s": t_enroll, "sep_s": t_sep,
                                               "audio_s": sum(m["hi"] - m["lo"] for m in ms)}, ensure_ascii=False, indent=1))
    print("登记音声纹", round(t_enroll, 1), "s；提取", round(t_sep, 1), "s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ref")
