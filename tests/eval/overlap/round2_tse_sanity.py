"""检查方法 C 的前后处理有没有接错（只用开发集一场会 R8009_M8019_MS810）：
1) 两个人各取单独说话的片段，0 dB 人为混合，用各自登记音提取，看 SI-SDR 提升多少；
2) 声纹余弦：同一人两组登记音 vs 不同人。"""
import sys
from pathlib import Path
import numpy as np, soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import round2_common as C  # noqa: E402
import round2_tse_extract as T  # noqa: E402


def sisdr(ref, est):
    a = np.dot(est, ref) / np.dot(ref, ref) * ref
    return 10 * np.log10(np.sum(a ** 2) / np.sum((est - a) ** 2))


s = "R8009_M8019_MS810"
wav = sf.read(C.D / "wav" / f"{s}.wav", dtype="float32")[0]
turns = [(r[0], r[1], r[2]) for r in C.stm(C.D / "ref" / f"{s}.stm")]
wins = [(m["lo"], m["hi"]) for m in C.meta() if m["session"] == s]
A, B = "N_SPK8023", "N_SPK8024"
sa, sb = T.solo(turns, wins, A), T.solo(turns, wins, B)
cut = lambda seg: wav[int(seg[0] * 16000):int(seg[1] * 16000)]
enr = lambda segs: np.concatenate([cut(g) for g in segs])[:15 * 16000]
eA, eA2, eB = T.embed(enr(sa[2:8])), T.embed(enr(sa[8:14])), T.embed(enr(sb[2:8]))
cos = lambda x, y: float(np.dot(x.ravel(), y.ravel()) / np.linalg.norm(x) / np.linalg.norm(y))
print(f"声纹余弦：同人 {cos(eA, eA2):.2f}  不同人 {cos(eA, eB):.2f} {cos(eA2, eB):.2f}")
res = []
for i in range(4):  # 用最长的两段之外的登记音，测试片段取最长的前两段
    xa, xb = cut(sa[i % 2]), cut(sb[i // 2])
    n = min(len(xa), len(xb), 6 * 16000); xa, xb = xa[:n], xb[:n]
    xb = xb * np.std(xa) / np.std(xb)
    mix = xa + xb
    ya, yb = T.extract(mix, eA), T.extract(mix, eB)
    res.append((sisdr(xa, mix), sisdr(xa, ya), sisdr(xb, mix), sisdr(xb, yb)))
    print(f"A: 混合 {res[-1][0]:5.1f} dB → 提取 {res[-1][1]:5.1f} dB   B: 混合 {res[-1][2]:5.1f} dB → 提取 {res[-1][3]:5.1f} dB")
r = np.array(res)
print(f"平均 SI-SDR 提升 {np.mean(r[:, [1, 3]] - r[:, [0, 2]]):.1f} dB")
