"""第 3 项第二轮 · 方法 B：M2MeT2.0 的 SA-ASR 基线（iic/speech_saasr_asr-zh-cn-16k-alimeeting）。

这个模型是在 AliMeeting Train 上训练的（真实会议重叠，和开发集同一来源：领域内优势），
一次解码按先后顺序输出多个人的话（用 $ 隔开），每段再按“说话人档案”（每人一个 x-vector）选一个人。
只能在 FunASR 0.8.8 里跑（1.x 里的 sa_asr 代码残缺），所以用单独的环境：

  tests/eval/.venv-saasr/bin/python tests/eval/overlap/round2_saasr.py [oracle|pya]

档案：每个说话人取这场会里自己单独说话（不和别人重叠、长于 0.5 秒、不在 20 处片段附近）的时间段，
各段 x-vector 取平均（做法同官方 egs 的 gen_oracle_embedding.py，只是去掉了重叠段）。
oracle = 按参考标注的说话人时间段；pya = 按 pyannote 系统输出（~/eval-out/pya/eval/*.ovl.rttm）的时间段。
输入只用第 1 路麦克风（和产品、第一轮一致），不用 8 路。
"""
import json, logging, sys, time
from pathlib import Path
import numpy as np, soundfile as sf, torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import round2_common as C  # noqa: E402
import funasr.bin.asr_infer as AI  # noqa: E402
from funasr.bin.asr_infer import Speech2TextSAASR  # noqa: E402
from funasr.bin.sv_infer import Speech2Xvector  # noqa: E402
from funasr.tasks.sa_asr import ASRTask  # noqa: E402

# 0.8.8 的 build_utils 建不出 SA-ASR（会去找 encoder），改用老的 tasks.sa_asr 来建模型
AI.build_model_from_file = lambda cfg, mf, cmvn, dev, *a, **k: ASRTask.build_model_from_file(cfg, mf, cmvn, dev)
from funasr.models.e2e_sa_asr import SAASRModel  # noqa: E402
_init = SAASRModel.__init__
# tasks.sa_asr 会多传 preencoder/postencoder（这个模型里都是 None），模型类不收，丢掉
SAASRModel.__init__ = lambda self, *a, preencoder=None, postencoder=None, **k: _init(self, *a, **k)

logging.disable(logging.WARNING)
torch.set_num_threads(8)
MS = Path.home() / ".cache/modelscope/models"
SA = next((MS / "iic--speech_saasr_asr-zh-cn-16k-alimeeting/snapshots").iterdir())
XV = MS / "iic--speech_xvector_sv-zh-cn-cnceleb-16k-spk3465-pytorch/snapshots/master"
mode = sys.argv[1] if len(sys.argv) > 1 else "oracle"
if not (C.OUT / "saasr_config.yaml").exists():  # 官方 config 里均值方差文件写的是训练机上的路径，换成模型目录里的 am.mvn
    import re
    s = (SA / "config.yaml").read_text()
    s = re.sub(r"stats_file: .*feats_stats.npz", f"stats_file: {SA / 'am.mvn'}", s)
    (C.OUT / "saasr_config.yaml").write_text(s)
out = C.OUT / f"saasr-{mode}"; out.mkdir(exist_ok=True)

xv = Speech2Xvector(sv_train_config=str(XV / "sv.yaml"), sv_model_file=str(XV / "sv.pth"), device="cpu")
xv.sv_model.eval()
s2t = Speech2TextSAASR(asr_train_config=str(C.OUT / "saasr_config.yaml"), asr_model_file=str(SA / "model.pb"),
                       device="cpu", beam_size=20, ctc_weight=0.6, lm_weight=0.0,
                       maxlenratio=0.0, minlenratio=0.0, penalty=0.0, nbest=1)


def solo_turns(turns, windows, max_n=40):
    """每人自己单独说话的时间段（去掉和别人重叠的部分、20 处片段前后 5 秒），长于 0.5 秒，取最长的 max_n 段。"""
    by = {}
    for spk, a, b in turns:
        cuts = [(a, b)]
        for s2, a2, b2 in turns:
            if s2 == spk or b2 <= a or a2 >= b:
                continue
            cuts = [p for c in cuts for p in ((c[0], min(c[1], a2)), (max(c[0], b2), c[1])) if p[1] - p[0] > 0]
        for lo, hi in windows:
            cuts = [p for c in cuts for p in ((c[0], min(c[1], lo - 5)), (max(c[0], hi + 5), c[1])) if p[1] - p[0] > 0]
        by.setdefault(spk, []).extend(c for c in cuts if c[1] - c[0] > 0.5)
    return {s: sorted(v, key=lambda c: c[0] - c[1])[:max_n] for s, v in by.items()}


def embed(x):
    with torch.no_grad():
        e = xv(torch.from_numpy(x.astype(np.float32)))[0]
    return e.squeeze(0).cpu().numpy()


ms = C.meta()
profiles = {}
t0 = time.time()
for sess in sorted({m["session"] for m in ms}):
    wav, _ = sf.read(C.D / "wav" / f"{sess}.wav", dtype="float32")
    if mode == "oracle":
        turns = [(r[0], r[1], r[2]) for r in C.stm(C.D / "ref" / f"{sess}.stm")]
    else:
        turns = C.rttm(Path.home() / f"eval-out/pya/eval/{sess}.ovl.rttm")
    st = solo_turns(turns, [(m["lo"], m["hi"]) for m in ms if m["session"] == sess])
    names = sorted(st)
    prof = np.stack([np.mean([embed(wav[int(a * 16000):int(b * 16000)]) for a, b in st[s]], axis=0) for s in names])
    profiles[sess] = (names, prof)
    print(sess, "档案", names, {s: round(sum(b - a for a, b in st[s]), 1) for s in names}, flush=True)
t_prof = time.time() - t0

tot = err_sa = err_cat = err_or = 0
t_dec = 0.0
rows = []
for m in ms:
    x, _ = sf.read(C.PROBE / f"{m['k']:02d}_mix.wav", dtype="float32")
    names, prof = profiles[m["session"]]
    t = time.time()
    with torch.no_grad():
        text, text_id, *_ = s2t(speech=torch.from_numpy(x)[None], speech_lengths=torch.tensor([len(x)]),
                                profile=torch.from_numpy(prof.astype(np.float32))[None],
                                profile_lengths=torch.tensor([len(prof)]))[0]
    t_dec += time.time() - t
    pieces = text.split("$")
    ids = [int(p[0]) - 1 for p in text_id.split("$")] if text_id else []
    streams = {}
    for p, i in zip(pieces, ids):
        streams.setdefault(i, []).append(C.norm(p))
    sa = C.score(m, ["".join(v) for v in streams.values()])  # 按模型给的说话人分路
    cat = C.score(m, ["".join(C.norm(p) for p in pieces)])  # 全拼成一路（只看字，不看分人）
    # 每段任意分给 A 或 B（事后最优，只作上限参考）
    best = None
    P = [C.norm(p) for p in pieces]
    for mask in range(1 << min(len(P), 12)):
        h = ["".join(p for j, p in enumerate(P) if mask >> j & 1), "".join(p for j, p in enumerate(P) if not mask >> j & 1)]
        c = C.score(m, h)
        best = c if best is None else min(best, c)
    n = C.nref(m); tot += n; err_sa += sa; err_cat += cat; err_or += best
    spk_hit = {names[i] for i in streams}
    rows.append({"k": m["k"], "n": n, "sa": sa, "cat": cat, "oracle_group": best, "text": text, "text_id": text_id,
                 "pred_spk": sorted(spk_hit), "ref_spk": [m["spkA"], m["spkB"]]})
    print(f"{m['k']:02d} {n:3d}字 分人 {sa / n:5.0%} 拼一路 {cat / n:5.0%} 最优分组 {best / n:5.0%} | {text[:40]} | 预测 {sorted(spk_hit)} 参考 {m['spkA']},{m['spkB']}", flush=True)
summary = {"mode": mode, "chars": tot, "cer_sa": err_sa / tot, "cer_concat": err_cat / tot, "cer_oracle_group": err_or / tot,
           "profile_s": t_prof, "decode_s": t_dec, "audio_s": sum(m["hi"] - m["lo"] for m in ms)}
(out / "rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
(out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
print(json.dumps(summary, ensure_ascii=False))
