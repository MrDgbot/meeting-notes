"""FunASR 封装：会后整段转写（含说话人分离）+ 会中实时转写（流式 VAD + 分段识别）。"""
import bisect
import json
import logging
import re
import subprocess
import threading
import time
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from funasr import AutoModel
from funasr.models.campplus import cluster_backend as _cb
from funasr.models.campplus.utils import postprocess as _sv_postprocess, sv_chunk as _sv_chunk
from pypinyin import Style, lazy_pinyin

import store

# FunASR 谱聚类里的 k-means 没固定随机种子，同一段录音每次分出的人数/归属都可能不同；固定下来
_cb.SpectralCluster.cluster_embs = lambda self, emb, k: _cb.k_means(emb, k, random_state=0, n_init=10)[1]

# 不指定人数时的聚类后处理
SV_STEP = 0.75        # 声纹小块的步长（秒），sv_chunk 的默认值
SPK_MIN_SEC = 30      # 总时长不到这么多秒的说话人，逐块并进最近的人
# 短录音按比例放低上面的门槛：门槛 = min(SPK_MIN_SEC, 语音总时长 × SPK_MIN_FRAC)。不然一两分钟的录音里除了说得最多的人谁都凑不够 30 秒，
# 全被并成一个人。语音超过 300 秒时和原来完全一样。选法见 docs/improvements.md 第二轮“短录音的人数”。
SPK_MIN_FRAC = 0.10
SPK_MERGE_THR = 0.72  # 两个说话人声纹中心的余弦相似度超过它就合并（FunASR 默认 0.78）
# 一句话里换了人、换过去的人连续说够这么多毫秒才切开；0 = 不切，整句归一人（选法见 docs/improvements.md 第 2 项）
SPLIT_MIN_MS = 1000
# 说话人分离用哪个（设置里的 asr.diarizer，没设时用 DIARIZER）。选法见 docs/improvements.md 第 4 项：
# "campp" = CAM++ 声纹小块聚类（cluster_speakers），默认；近场录音（笔记本、手机放桌上）上明显更好。
# "pyannote" = 子进程跑 pyannote community-1（diarize_worker.py）+ 用 CAM++ 声纹合并太像的说话人（PYA_MERGE_THR）；
#   会议室远场、多人围坐抢话时人数和说话人更准，但会把近场长录音里说得最多的人拆成两个。失败时自动退回 CAM++。
DIARIZER = "campp"
DIARIZERS = {
    "campp": "标准（推荐）：笔记本、手机放在桌上录，或线上会议",
    "pyannote": "会议室远场：多人围坐、离麦克风远、经常抢话（首次使用下载约 31 MB 模型）",
}
PYA_MERGE_THR = 0.78


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def min_cluster_sec(segs: list) -> float:
    """小簇门槛（秒）：segs 是整段录音的语音段 [开始ms, 结束ms]。"""
    return min(SPK_MIN_SEC, SPK_MIN_FRAC * sum(e - s for s, e in segs) / 1000)


def _assign_nearest(labels: np.ndarray, X: np.ndarray, idx: np.ndarray, pool: np.ndarray) -> None:
    """把 idx 这些块分给 pool 里（标签 ≥ 0 的块）声纹中心最近的说话人，原地改 labels。"""
    ks = sorted(set(pool[pool >= 0].tolist()))
    C = _unit(np.stack([X[pool == k].mean(0) for k in ks]))
    labels[idx] = np.array(ks)[np.argmax(_unit(X[idx]) @ C.T, axis=1)]


def cluster_speakers(X: np.ndarray, cb, seed: int = 0, min_sec: float = SPK_MIN_SEC,
                     merge_thr: float = SPK_MERGE_THR) -> np.ndarray:
    """不知道人数时给每个声纹小块分说话人。和 FunASR ClusterBackend.forward 的区别：
    - UMAP 固定随机种子（FunASR 没固定，同一段录音每次人数可能不同）；
    - HDBSCAN 拿不准的块标成 -1，FunASR 后面会把 -1 当成一个独立的人、合并时又跳过它，
      于是多出一个永远并不掉的“噪声人”。这里先把这些块分给最近的人；
    - 总时长不到 min_sec 秒的小簇，最小的先拆，逐块并进剩下的人里最近的那个；
    - 最后按 merge_thr 合并相近的说话人。"""
    if X.shape[0] < 20:
        return np.zeros(X.shape[0], dtype=int)
    if X.shape[0] < 2048:
        labels = np.asarray(cb.spectral_cluster(X, None)).copy()
    else:  # 参数同 FunASR 的 UmapHdbscan
        import umap.umap_ as umap
        from sklearn.cluster import HDBSCAN
        u = umap.UMAP(n_neighbors=20, min_dist=0.0, n_components=min(60, X.shape[0] - 2), metric="cosine",
                      random_state=seed).fit_transform(X)
        labels = HDBSCAN(min_samples=10, min_cluster_size=10, allow_single_cluster=True).fit_predict(u)
    if (labels < 0).any() and (labels >= 0).any():
        _assign_nearest(labels, X, np.where(labels < 0)[0], labels)
    while min_sec > 0:
        ks = [k for k in set(labels.tolist()) if k >= 0]
        if len(ks) < 2:
            break
        small = min(ks, key=lambda k: (labels == k).sum())
        if (labels == small).sum() * SV_STEP >= min_sec:
            break
        _assign_nearest(labels, X, np.where(labels == small)[0], np.where(labels != small, labels, -1))
    # FunASR 的 merge_by_cos 要求标签从 0 连续编号
    m = labels >= 0
    if m.any():
        uniq = sorted(set(labels[m].tolist()))
        lab = np.searchsorted(uniq, labels[m])
        labels = labels.copy()
        labels[m] = cb.merge_by_cos(lab, X[m], merge_thr) if len(uniq) > 1 else lab
    return labels


def merge_turn_speakers(turns: list[tuple], chunk_t: list, X: np.ndarray, thr: float | None = None) -> list[tuple]:
    """把 pyannote 分出来、但 CAM++ 声纹其实很像的说话人并成一个（选法见 docs/improvements.md 第 4 项）。
    pyannote 在近场长录音里会把说得最多的那个人拆成两个（一场 95 分钟的近场周会：一个人 2300 秒被拆成 1181 + 1004 秒）。
    做法：每个 CAM++ 声纹小块归给和它重合最多的 pyannote 说话人，算每人的声纹中心；
    两两余弦相似度超过 thr（默认 SPK_MERGE_THR，和 CAM++ 聚类合并用的同一个阈值）就并，最像的一对先并，并完重算，直到没有超过的。
    chunk_t：每块的 [开始秒, 结束秒]；turns：[(开始ms, 结束ms, 说话人)]。说话人按第一次出现的先后重新编号。"""
    thr = SPK_MERGE_THR if thr is None else thr
    if not turns or len(X) == 0:
        return turns
    tl = sorted(turns)
    starts = [t[0] for t in tl]
    U = _unit(np.asarray(X, dtype=np.float64))
    members: dict[int, list[int]] = {}
    for i, (a, b) in enumerate(chunk_t):
        a, b = a * 1000, b * 1000
        k = max(bisect.bisect_right(starts, a) - 1, 0)
        best, best_ov = None, 0.0
        while k < len(tl) and tl[k][0] < b:
            ov = min(b, tl[k][1]) - max(a, tl[k][0])
            if ov > best_ov:
                best, best_ov = tl[k][2], ov
            k += 1
        if best is not None:
            members.setdefault(best, []).append(i)
    groups = {s: list(ix) for s, ix in members.items()}
    root = {s: s for s in {t[2] for t in tl}}
    while len(groups) > 1:
        ks = sorted(groups)
        C = _unit(np.stack([U[groups[k]].mean(0) for k in ks]))
        S = C @ C.T
        np.fill_diagonal(S, -1)
        i, j = np.unravel_index(np.argmax(S), S.shape)
        if S[i, j] <= thr:
            break
        a, b = ks[i], ks[j]
        if len(groups[b]) > len(groups[a]):
            a, b = b, a
        groups[a] += groups.pop(b)
        for s, r in root.items():
            if r == b:
                root[s] = a
    order: dict[int, int] = {}
    return [(a, b, order.setdefault(root[s], len(order))) for a, b, s in tl]

log = logging.getLogger("asr")
DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
SR = 16000
PUNC_RE = re.compile(r"[，。？！、,.?!；;：:\s]")
CLAUSE_END = set("，。？！；：、,.?!;:")
NANO = "FunAudioLLM/Fun-ASR-Nano-2512"
ASR_MODELS = {
    "nano": "Fun-ASR-Nano（推荐：远场、小声、口音、中英混说明显更准）",
    "paraformer": "Paraformer（更快、占内存少，近距离清晰录音够用）",
    "hanbao": "憨包云端（会后精准转写更准，ASIN 等中英混说认得出；录音会上传到对方服务器，失败的段自动用本机 Nano 补）",
}
LOCAL_MODES = ("nano", "paraformer")
# 中文字符两侧的空格去掉（Nano 在句子之间会输出空格），英文单词之间的保留
CJK_SPACE_RE = re.compile(r"(?<=[^\x00-\x7f])\s+|\s+(?=[^\x00-\x7f])")
from vocab import SPELLED_RE  # noqa: E402  Nano 常把缩写拆成单个字母输出，拼回去


def asr_mode() -> str:
    m = (store.get_settings().get("asr") or {}).get("model", "nano")
    return m if m in ASR_MODELS else "nano"


def diarizer_mode() -> str:
    m = (store.get_settings().get("asr") or {}).get("diarizer") or DIARIZER
    return m if m in DIARIZERS else "campp"


def hotword_list(hotword: str) -> list[str]:
    return [w for w in re.split(r"[\s,，、;；]+", hotword or "") if w]


# Nano 偶尔把提示里的“热词列表：[…]”吐出来，或输出 [&] 之类的标记
PROMPT_LEAK_RE = re.compile(r"[\[\]]")


def _py(s: str) -> list[str]:
    """拼音（无声调），平翘舌、前后鼻音归一，方便比较“听起来像不像”。"""
    out = []
    for p in lazy_pinyin(s, style=Style.NORMAL, errors="ignore"):
        p = p.lower()
        p = re.sub(r"^([zcs])h", r"\1", p)
        out.append(re.sub(r"ng$", "n", p))
    return out


def _sounds_like(word: str, heard: str) -> bool:
    """word 是否在 heard（CTC 结果，只看声音、不受热词影响）里有读音相近的片段。"""
    if word.lower() in heard.lower():
        return True
    if re.fullmatch(r"[\x00-\x7f]+", word):  # 英文热词：按字母相似度
        h, w = re.sub(r"[^a-z0-9]", "", heard.lower()), re.sub(r"[^a-z0-9]", "", word.lower())
        return any(SequenceMatcher(None, w, h[i:i + len(w)]).ratio() >= 0.75 for i in range(max(1, len(h) - len(w) + 1)))
    wp, hp = _py(word), _py(heard)
    n = len(wp)
    if not n or len(hp) < n:
        return False
    best = max(sum(SequenceMatcher(None, a, b).ratio() for a, b in zip(wp, hp[i:i + n])) / n
               for i in range(len(hp) - n + 1))
    return best >= 0.7


def hotwords_credible(text: str, ctc: str, hotwords: list[str]) -> bool:
    """热词加进提示后，Nano 在听不清的地方会硬塞热词（实测“长相就没意义”→“长尾词][”）。
    用 CTC 分支核对：输出里出现的热词，声音里得有读音相近的片段。"""
    if PROMPT_LEAK_RE.search(text):
        return False
    return all(_sounds_like(w, ctc) for w in hotwords if w.lower() in text.lower())


def fmt_ts(ms: float) -> str:
    s = int(ms // 1000)
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def _boost(a: np.ndarray, target_db: float = -22.0, max_gain_db: float = 24.0) -> np.ndarray:
    """把偏小声的音频按 RMS 放大到 target_db（只放大不缩小，最多放大 max_gain_db）。"""
    rms = float(np.sqrt(np.mean(np.square(a, dtype=np.float64)))) if len(a) else 0.0
    if rms <= 1e-6:
        return a
    gain_db = min(target_db - 20 * np.log10(rms), max_gain_db)
    if gain_db <= 0:
        return a
    return np.clip(a * (10 ** (gain_db / 20)), -1.0, 1.0).astype(np.float32)


# 会后转写前的音量归一（选法和测试结果见 docs/improvements.md 第 1 项）。
# 离麦克风远、说话小声的人，整段录音只有 -50 dBFS 上下，VAD 会把他整段当成静音（AliMeeting 上有人 91% 的话被漏掉）。
# 整段按 RMS 放大到 LEVEL_DB：只放大不缩小，最多放大 LEVEL_MAX_GAIN_DB，0.8 以上软限幅免得削波。
LEVEL_DB = -30.0
LEVEL_MAX_GAIN_DB = 30.0
LEVEL_USE = "all"  # "off" 不处理；"vad" 只给语音检测用；"all" 识别和声纹也用放大后的音频（pyannote 总是用原始录音）


def level(x: np.ndarray, target_db: float | None = None, max_gain_db: float | None = None) -> np.ndarray:
    target_db = LEVEL_DB if target_db is None else target_db
    max_gain_db = LEVEL_MAX_GAIN_DB if max_gain_db is None else max_gain_db
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0
    if rms <= 1e-7:
        return x
    gain_db = min(target_db - 20 * np.log10(rms), max_gain_db)
    if gain_db <= 0.5:
        return x
    y = x.astype(np.float32) * np.float32(10 ** (gain_db / 20))
    a = np.abs(y)
    over = a > 0.8
    y[over] = np.sign(y[over]) * (0.8 + 0.2 * np.tanh((a[over] - 0.8) / 0.2))
    return y


def level_pair(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """按 LEVEL_USE 返回 (识别和声纹用的音频, 语音检测用的音频)。"""
    if LEVEL_USE == "off":
        return x, x
    y = level(x)
    return (y if LEVEL_USE == "all" else x), y


def to_wav16k(src: str | Path, dst: str | Path) -> None:
    p = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ar", "16000", "-ac", "1", str(dst)],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError("音频解码失败: " + p.stderr.strip()[:300])


def pcm_to_wav(pcm: Path, wav: Path) -> None:
    p = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", str(pcm), str(wav)],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError("录音保存失败: " + p.stderr.strip()[:300])


def make_mp3(wav: Path, mp3: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-b:a", "64k", str(mp3)],
        capture_output=True,
    )


def duration_of(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


class Engine:
    def __init__(self):
        self.full = None  # Paraformer 管线：VAD + ASR + 标点 + 说话人（Nano 模式下只用它切分说话人）
        self.live_asr = None  # Paraformer 片段识别（仅 paraformer 模式按需加载；标点复用 full 的）
        self.nano = None  # Fun-ASR-Nano：片段识别 + 精准转写的文字（nano 模式）
        self.ready = False
        self.error = ""
        self.loading = False
        self.nano_error = ""  # Nano 加载失败的原因；失败后不再每句话都重试（每次重试都占着 GPU 锁），等用户手动重试
        self.nano_loading = False
        # MPS 不支持多线程同时推理（会触发 Metal 断言直接崩溃进程），所有模型共用一把锁。
        # 长任务按段加锁，实时识别可以在段与段之间插队。
        gpu = threading.RLock()
        self.full_lock = self.live_lock = self.punc_lock = self.nano_lock = gpu
        self.load_lock = threading.Lock()
        self._last_trim = 0.0
        self.last_info: dict = {}  # 最近一次会后转写用了什么引擎、云端失败几段等
        self.common = dict(device=DEVICE, disable_update=True, disable_pbar=True, disable_log=True)

    def load(self):
        """加载语音模型。启动时调用一次；加载失败后可从网页上点“重试”再调用。"""
        if self.loading or self.ready:
            return
        self.loading, self.error = True, ""
        try:
            t = time.time()
            if self.full is None:
                self.full = AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc",
                                      spk_model="cam++", **self.common)
            self.ensure(asr_mode())
            self.new_vad()
            self.trim(force=True)
            self.ready = True
            log.info("ASR models ready on %s in %.1fs (mode=%s)", DEVICE, time.time() - t, asr_mode())
        except Exception as e:  # noqa: BLE001
            self.error = str(e) or type(e).__name__
            log.exception("ASR load failed")
        finally:
            self.loading = False

    def ensure(self, mode: str, force: bool = False) -> str:
        """按需加载本机识别模型；Nano 加载失败时退回 Paraformer。返回实际可用的本机模式。
        憨包模式下实时出字和失败回退都用本机 Nano。
        Nano 加载失败一次后不再自动重试（否则每识别一句都要重新加载、占着 GPU 锁），force=True 时才重试。"""
        if mode == "hanbao":
            mode = "nano"
        if mode == "nano" and self.nano is None and self.nano_error and not force:
            mode = "paraformer"
        with self.load_lock, self.full_lock:  # 加载也要占 GPU 锁
            if mode == "nano" and self.nano is None:
                self.nano_loading = True
                try:
                    t = time.time()
                    self.nano = AutoModel(model=NANO, **self.common)
                    self.nano.generate(input=torch.zeros(SR), language="中文", itn=True)  # 预热
                    self.nano_error = ""
                    log.info("Fun-ASR-Nano loaded in %.1fs", time.time() - t)
                except Exception as e:  # noqa: BLE001
                    log.exception("Fun-ASR-Nano load failed, falling back to paraformer")
                    self.nano = None
                    self.nano_error = (str(e) or type(e).__name__)[:300]
                finally:
                    self.nano_loading = False
            if mode == "nano" and self.nano is not None:
                return "nano"
            if self.live_asr is None:
                self.live_asr = AutoModel(model="paraformer-zh", **self.common)
                self.live_asr.generate(input=np.zeros(SR, dtype=np.float32))
            return "paraformer"

    @staticmethod
    def new_vad(max_end_silence_time: int = 500, max_single_segment_time: int = 20000, **kw):
        """kw 可传 speech_noise_thres（越小越灵敏，模型默认 0.6）。"""
        return AutoModel(model="fsmn-vad", max_end_silence_time=max_end_silence_time,
                         max_single_segment_time=max_single_segment_time, device="cpu",
                         disable_update=True, disable_pbar=True, disable_log=True, **kw)

    @staticmethod
    def _offline_segs(x: np.ndarray, vad_kw: dict | None = None) -> list:
        """整段音频的语音段 [[开始ms, 结束ms]]。用 VAD 默认参数：会把相邻语音并成最长 30 秒的大段。"""
        vad = AutoModel(model="fsmn-vad", max_single_segment_time=30000, device="cpu",
                        disable_update=True, disable_pbar=True, disable_log=True, **(vad_kw or {}))
        return vad.generate(input=x)[0]["value"]

    def trim(self, force: bool = False, every: float = 20.0):
        """释放 MPS / CUDA 缓存。输入长度每次不同，PyTorch 的 MPS 缓存会只涨不降（实测 300 次识别涨 6GB），
        定期 empty_cache 即可回落；它只释放空闲块，不影响正在进行的推理。"""
        if DEVICE not in ("mps", "cuda"):
            return
        now = time.time()
        if force or now - self._last_trim >= every:
            self._last_trim = now
            (torch.cuda if DEVICE == "cuda" else torch.mps).empty_cache()

    # ---------- 标点 ----------
    def repunc(self, text: str) -> str:
        raw = PUNC_RE.sub("", text)
        if not raw:
            return text
        try:
            with self.punc_lock:
                return self.full.inference(raw, model=self.full.punc_model, kwargs=self.full.punc_kwargs)[0]["text"]
        except Exception:  # noqa: BLE001
            return text

    def _nano(self, audio: np.ndarray, hotword: str = "") -> dict:
        hws = hotword_list(hotword)
        x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))

        def run(with_hw: bool) -> dict:
            kw = {"hotwords": hws} if with_hw and hws else {}
            with self.nano_lock:
                r = self.nano.generate(input=x, language="中文", itn=True, **kw)
            return r[0] if r else {}
        r = run(True)
        if hws and not hotwords_credible(r.get("text") or "", r.get("ctc_text") or "", hws):
            log.info("hotword not credible, re-decode without: %r (ctc %r)", r.get("text"), r.get("ctc_text"))
            r = run(False)
        # LLM 解码在噪声上偶尔会“编”出一句话；此时 CTC 分支是空的，据此丢掉
        if not (r.get("ctc_text") or "").strip():
            return {"text": "", "timestamps": []}
        text = re.sub(r"\[[^\]\[]{0,4}\]|[\[\]]", "", r.get("text") or "")
        text = SPELLED_RE.sub(r"\1", CJK_SPACE_RE.sub("", text.strip()))
        return {"text": text, "timestamps": r.get("timestamps") or []}

    def asr_segment(self, audio: np.ndarray, hotword: str = "", punc: bool = True) -> str:
        """识别一小段 16k float32 音频（几百毫秒到几十秒）。"""
        if len(audio) < SR * 0.2:
            return ""
        if self.ensure(asr_mode()) == "nano":
            text = self._nano(audio, hotword)["text"]
            self.trim()
            return text
        kw = {"hotword": hotword} if hotword else {}
        with self.live_lock:
            r = self.live_asr.generate(input=audio, **kw)
        text = (r[0].get("text") or "").strip() if r else ""
        text = self.repunc(text) if (text and punc) else text
        self.trim()
        return text

    # ---------- 会后整段转写 ----------
    def transcribe(self, wav: Path, num_spk: int = 0, hotword: str = "", vad_kw: dict | None = None) -> list[dict]:
        """vad_kw：切分语音用的 VAD 参数。全天模式的录音传和采集时相同的灵敏度，
        否则采集时录下的小声发言，到这里又被当成静音丢掉。"""
        self.last_info = {}
        cloud_failed = ""
        if asr_mode() == "hanbao":
            try:
                paras = self._cloud_transcribe(wav, num_spk, hotword, vad_kw)
                if paras is not None:
                    self.trim(force=True)
                    return paras
                cloud_failed = self.last_info.get("error") or "大部分片段识别失败"
            except Exception as e:  # noqa: BLE001
                log.exception("hanbao transcribe failed, falling back to local")
                cloud_failed = f"{type(e).__name__}: {e}"[:200]
        mode = self.ensure(asr_mode())
        # 憨包整体失败改用本机时记下原因，网页上显示“憨包云端失败，已改用本机识别”
        self.last_info = {"engine": mode, **({"cloud_failed": cloud_failed} if cloud_failed else {})}
        if asr_mode() == "nano" and mode != "nano" and self.nano_error:
            self.last_info["nano_failed"] = self.nano_error
        if mode == "nano":
            # 说话人：按 1.5s 小块的声纹聚类；文字：Nano 识别。不再跑 Paraformer 整段识别
            try:
                paras = self._paragraphs(self._nano_transcribe(wav, num_spk, hotword, vad_kw))
                self.trim(force=True)
                return paras
            except Exception:  # noqa: BLE001
                log.exception("nano transcribe failed, falling back to paraformer")
        kw = {"batch_size_s": 300}
        if num_spk and num_spk > 0:
            kw["preset_spk_num"] = int(num_spk)
        if hotword.strip():
            kw["hotword"] = hotword.strip()
        inp: str | np.ndarray = str(wav)
        if LEVEL_USE != "off":  # Paraformer 管线自带 VAD，分不开：音量归一后整段送进去（相当于 "all"）
            xw, _ = sf.read(str(wav), dtype="float32")
            inp = level(xw[:, 0] if xw.ndim > 1 else xw)
        with self.full_lock:
            res = self.full.generate(input=inp, **kw)[0]
            sents = res.get("sentence_info") or []
            if not sents and res.get("text"):
                sents = [{"spk": 0, "start": 0, "end": int(duration_of(wav) * 1000), "text": res["text"]}]
            paras = self._paragraphs(sents)
            for p in paras:
                p["text"] = self.repunc(p["text"])
        self.trim(force=True)
        return paras

    def _cloud_transcribe(self, wav: Path, num_spk: int, hotword: str, vad_kw: dict | None = None) -> list[dict] | None:
        """憨包云端识别文字，本机做 VAD + 说话人分离。
        憨包只给整段文字、没有逐字时间，所以先按说话人把语音切成单元（见 _speaker_units），
        每个单元整段识别，说话人直接取单元的。云端失败/没出字的单元用本机模型补。
        大部分单元都失败（断网、接口失效）时返回 None，整场改走本机流程。"""
        import hanbao_asr
        x, sr = sf.read(str(wav), dtype="float32")
        if x.ndim > 1:
            x = x[:, 0]
        x, xv = level_pair(x)
        segs = self._offline_segs(xv, vad_kw)
        if not segs:
            self.last_info = {"engine": "hanbao", "units": 0}
            return []
        turns = self._diarize(x, segs, num_spk, wav=wav)
        units = self._speaker_units(segs, turns)
        total_ms = len(x) * 1000 // SR
        clips = []
        for i, (s, e, _) in enumerate(units):
            s = max(s - 200, units[i - 1][1] if i else 0, 0)
            e = min(e + 200, units[i + 1][0] if i + 1 < len(units) else total_ms)
            clips.append(x[int(s * SR / 1000):int(e * SR / 1000)])
        t = time.time()
        # 憨包把很小声的段当成没人说话（实测没出字的段音量中位数 -34dB，出字的 -28dB）；
        # 小声的段先放大到 -22dB 再发，能多认出约四成。本机补的时候仍用原始音频
        res = hanbao_asr.recognize_many([_boost(c) for c in clips], concurrency=16)  # 实测 16 路无报错，比 8 路快近一倍
        errs = [r for r in res if isinstance(r, Exception)]
        log.info("hanbao: %d units in %.1fs, %d failed%s", len(res), time.time() - t, len(errs),
                 f" ({errs[0]!r})" if errs else "")
        if len(errs) > max(2, len(res) // 2):
            self.last_info = {"error": f"{len(errs)}/{len(res)} 段失败：{errs[0]}"[:200]}
            return None
        sents, n_local = [], 0
        for (s, e, spk), clip, r in zip(units, clips, res):
            text = "" if isinstance(r, Exception) else r["text"]
            if not text.strip() and len(clip) >= SR * 1.5:  # 云端失败/没出字：本机补
                text = self.asr_segment(clip, hotword)
                n_local += bool(text)
            text = SPELLED_RE.sub(r"\1", CJK_SPACE_RE.sub("", text.strip()))
            if text:
                sents.append({"spk": spk, "start": s, "end": e, "text": text})
        self.last_info = {**{k: v for k, v in self.last_info.items() if k.startswith("diarizer")},
                          "engine": "hanbao", "units": len(units), "failed": len(errs), "local": n_local}
        return self._paragraphs(sents)

    @staticmethod
    def _speaker_units(segs: list, turns: list[tuple], min_turn: int = 2000, gap: int = 3000,
                       max_len: int = 25000) -> list[list[int]]:
        """切成发给憨包的识别单元，返回 [[开始ms, 结束ms, 说话人]]。
        憨包对一两秒的短音频大多返回空（实测单个 VAD 段中位数才 1 秒，单独发近六成没出字；
        停顿 ≤3s 的合起来发，没出字的降到 0，认出的字多 26%），所以要尽量切长：
        1. VAD 段在说话人切换处切成片段，同一人连续的片段归成一轮；
        2. 说话时长不足 min_turn 的一轮视为声纹抖动或附和，并入时间上更近的相邻一轮（相隔不超过 gap 才并）；
        3. 每轮内停顿 ≤gap 的相邻片段合并成 ≤max_len 的单元。"""
        pieces: list[list[int]] = []
        for s, e in segs:
            ov = sorted((max(s, ts), min(e, te), spk) for ts, te, spk in turns if min(e, te) > max(s, ts))
            if not ov:
                pieces.append([s, e, Engine._spk_at(turns, s, e) if turns else 0])
                continue
            first = len(pieces)
            for a, _, spk in ov:
                if len(pieces) > first and pieces[-1][2] == spk:
                    continue
                if len(pieces) > first:
                    pieces[-1][1] = a
                pieces.append([a, e, spk])
            pieces[first][0] = s
        # runs: [片段列表, 说话人, 说话时长]
        runs: list[list] = []
        for p in pieces:
            if runs and runs[-1][1] == p[2]:
                runs[-1][0].append(p)
                runs[-1][2] += p[1] - p[0]
            else:
                runs.append([[p], p[2], p[1] - p[0]])

        def join(i: int, j: int, spk: int):  # 合并相邻的 runs[i]、runs[j]
            lo, hi = min(i, j), max(i, j)
            for p in runs[lo][0] + runs[hi][0]:
                p[2] = spk
            runs[lo:hi + 1] = [[runs[lo][0] + runs[hi][0], spk, runs[lo][2] + runs[hi][2]]]
            return lo

        inf = float("inf")
        while len(runs) > 1:
            best = None
            for i, r in enumerate(runs):
                if r[2] >= min_turn or (best is not None and r[2] >= runs[best[0]][2]):
                    continue
                gp = r[0][0][0] - runs[i - 1][0][-1][1] if i > 0 else inf
                gn = runs[i + 1][0][0][0] - r[0][-1][1] if i + 1 < len(runs) else inf
                if min(gp, gn) <= gap:
                    best = (i, i - 1 if gp <= gn else i + 1)
            if best is None:
                break
            i, j = best
            k = join(i, j, runs[j][1])
            spk = runs[k][1]
            if k + 1 < len(runs) and runs[k + 1][1] == spk:
                join(k, k + 1, spk)
            if k > 0 and runs[k - 1][1] == spk:
                join(k - 1, k, spk)
        units: list[list[int]] = []
        for ps, spk, _ in runs:
            cur = None
            for p in ps:
                if cur and p[0] - cur[1] <= gap and p[1] - cur[0] <= max_len:
                    cur[1] = p[1]
                else:
                    cur = [p[0], p[1], spk]
                    units.append(cur)
        return units

    def _diarize_pyannote(self, wav: Path, num_spk: int = 0) -> list[tuple[int, int, int]]:
        import sys
        import tempfile
        out = Path(tempfile.mkstemp(suffix=".json", prefix="diar-")[1])
        try:
            p = subprocess.run([sys.executable, str(Path(__file__).with_name("diarize_worker.py")), str(wav), str(out),
                                str(int(num_spk or 0))], capture_output=True, text=True,
                               timeout=max(900, duration_of(wav) * 1.5))
            if p.returncode != 0:
                raise RuntimeError((p.stderr or "").strip().splitlines()[-1][:300] if p.stderr.strip() else f"exit {p.returncode}")
            r = json.loads(out.read_text())
        finally:
            out.unlink(missing_ok=True)
        log.info("pyannote diarization on %s: load %.1fs, run %.1fs, %d turns", r.get("device"), r.get("load_s", 0),
                 r.get("run_s", 0), len(r["turns"]))
        return [(int(a), int(b), int(s)) for a, b, s in r["turns"]]

    def _diarize(self, x: np.ndarray, segs: list, num_spk: int = 0, wav: Path | None = None) -> list[tuple[int, int, int]]:
        """说话人分离 → [(开始ms, 结束ms, 说话人)]，每个时刻一个人。
        diarizer_mode() 是 "pyannote" 且给了 wav：子进程跑 pyannote（用原始录音，不受 LEVEL_USE 影响），
        再用 CAM++ 声纹合并太像的说话人；出错就退回下面的 CAM++。
        CAM++：语音段切成 1.5s 小块（步长 0.75s）提 CAM++ 声纹 → 聚类。
        以前借用 Paraformer 的整句来定说话人，一句里夹着两个人就整句归给一个人，
        而且远场录音里 Paraformer 的句子时间会整体偏几秒，说话人跟着错位。"""
        if diarizer_mode() == "pyannote" and wav is not None:
            try:
                turns = self._diarize_pyannote(wav, num_spk)
                if not (num_spk and num_spk > 0):  # 指定了人数就照 pyannote 的，不再合并
                    chunks, X = self._spk_embeddings(x, segs)
                    n0 = len({t[2] for t in turns})
                    turns = merge_turn_speakers(turns, [[c[0], c[1]] for c in chunks], X, PYA_MERGE_THR)
                    log.info("pyannote speakers %d -> %d after CAM++ merge", n0, len({t[2] for t in turns}))
                self.last_info["diarizer"] = "pyannote"
                return turns
            except Exception as e:  # noqa: BLE001
                log.exception("pyannote diarization failed, falling back to CAM++")
                self.last_info["diarizer_failed"] = f"{type(e).__name__}: {e}"[:200]
        self.last_info["diarizer"] = "campp"
        chunks, X = self._spk_embeddings(x, segs)
        if not chunks:
            return []
        if num_spk and num_spk > 0:  # 用户指定了人数：照旧交给 FunASR
            labels = self.full.cb_model(X, oracle_num=int(num_spk))
        else:
            labels = cluster_speakers(X, self.full.cb_model, min_sec=min_cluster_sec(segs))
        return [(int(a * 1000), int(b * 1000), int(s)) for a, b, s in _sv_postprocess(chunks, None, labels, X)]

    def _spk_embeddings(self, x: np.ndarray, segs: list) -> tuple[list, np.ndarray]:
        """语音段切成 1.5s 小块（步长 0.75s），每块一个 CAM++ 声纹。返回 (小块 [开始秒, 结束秒, 音频], 声纹矩阵)。"""
        chunks = _sv_chunk([[s / 1000, e / 1000, x[int(s * SR / 1000):int(e * SR / 1000)]] for s, e in segs])
        if not chunks:
            return [], np.zeros((0, 192), dtype=np.float32)
        embs = []
        for i in range(0, len(chunks), 128):  # 分批占 GPU，实时识别可以插队
            with self.full_lock:
                res = self.full.inference([c[2] for c in chunks[i:i + 128]], input_len=None,
                                          model=self.full.spk_model, kwargs=self.full.spk_kwargs)
            embs.append(torch.cat([r["spk_embedding"] for r in res]).cpu())
        return chunks, torch.cat(embs).numpy()

    def _nano_transcribe(self, wav: Path, num_spk: int, hotword: str, vad_kw: dict | None = None) -> list[dict]:
        x, sr = sf.read(str(wav), dtype="float32")
        if x.ndim > 1:
            x = x[:, 0]
        x, xv = level_pair(x)
        # 相邻语音并成最长 30 秒的大段，Nano 上下文越长越准（切成碎句明显变差）
        segs = self._offline_segs(xv, vad_kw)
        turns = self._diarize(x, segs, num_spk, wav=wav)
        # 停顿 ≤1.2s 的相邻段连同停顿一起识别：VAD 常在句中换气处切开，后半句没了上下文就认错
        # （实测“通过各个层面的数据去看”被切成两段后认成“你出货/团队的数据”）。
        # 停顿放宽到 2s 反而变差：夹进太多噪声，Nano 会丢标点、错字变多。
        merged: list[list[int]] = []
        for s, e in segs:
            if merged and s - merged[-1][1] <= 1200 and e - merged[-1][0] <= 25000:
                merged[-1][1] = e
            else:
                merged.append([s, e])
        clauses = []
        total_ms = len(x) * 1000 // SR
        for i, (s, e) in enumerate(merged):
            # 前后各留 0.2s（不越过相邻段）：VAD 边界很紧，不留白句尾一两个字常被截掉（“再批”→“再。”）
            s = max(s - 200, merged[i - 1][1] if i else 0, 0)
            e = min(e + 200, merged[i + 1][0] if i + 1 < len(merged) else total_ms)
            a = x[int(s * SR / 1000):int(e * SR / 1000)]
            if len(a) < SR * 0.2:
                continue
            r = self._nano(a, hotword)  # 每段单独加锁，期间实时识别可以插队
            if r["text"]:
                clauses += self._clauses(r["text"], r["timestamps"], s, e)
            self.trim()
        return self._assign_speakers(clauses, turns)

    @classmethod
    def _assign_speakers(cls, clauses: list[dict], turns: list[tuple], min_ms: float | None = None) -> list[dict]:
        """给小句定说话人。按整句定（句号/问号/感叹号结尾，或与下一小句停顿 ≥1s 处断开）：取整句时间内声纹占多数的人。
        逐小句判断在远场录音里会在一句话中间来回跳（“我花二十块钱了，｜我讲四十块钱”分给两个人）。
        但 Nano 常把两个人的话识别成一句（“……办几天比较合适呀都是一天吧。”），整句只能归给一个人：
        min_ms > 0 时按逐字时间戳看声纹，句中换了人、而且换过去的人连续说够 min_ms 毫秒，就在那里切开（见 _split_sentence）。"""
        min_ms = SPLIT_MIN_MS if min_ms is None else min_ms
        out: list[dict] = []
        sent: list[dict] = []
        for i, c in enumerate(clauses):
            sent.append(c)
            nxt = clauses[i + 1] if i + 1 < len(clauses) else None
            if nxt is None or c["text"][-1] in "。？！?!" or nxt["start"] - c["end"] >= 1000:
                spk = cls._spk_major(turns, sent)
                for x_ in sent:
                    x_["spk"] = spk
                out += cls._split_sentence(sent, turns, min_ms) if (min_ms > 0 and turns) else sent
                sent = []
        return out

    @staticmethod
    def _split_sentence(sent: list[dict], turns: list[tuple], min_ms: float) -> list[dict]:
        """一句话（几个小句）按逐字的说话人切开：每个字取它时间中点所在的说话人时间段（没时间戳的字跟前一个字），
        连续同一人的字成一串；不到 min_ms 的串并进相邻的串（两边是同一人就三串并一）。
        只剩一串就原样返回（说话人仍按整句多数）；否则在串的边界切开，边界前后 3 个字以内有标点就挪到标点后面。"""
        chars: list[tuple] = []
        for c in sent:
            ct = c.get("ct") or [None] * len(c["text"])
            chars += list(zip(c["text"], ct))
        tl = sorted(turns)
        starts = [t[0] for t in tl]

        def spk_of(ms: float) -> int:
            k = bisect.bisect_right(starts, ms) - 1
            if k >= 0 and tl[k][1] > ms:
                return tl[k][2]
            cand = [j for j in (k, k + 1) if 0 <= j < len(tl)]
            return tl[min(cand, key=lambda j: min(abs(tl[j][0] - ms), abs(tl[j][1] - ms)))][2]

        labs, prev = [], None
        for _, t in chars:
            if t:
                prev = spk_of((t[0] + t[1]) / 2)
            labs.append(prev)
        first = next((v for v in labs if v is not None), None)
        if first is None:
            return sent
        labs = [first if v is None else v for v in labs]
        runs: list[list] = []  # [说话人, 起始字下标, 结束字下标（不含）]
        for i, v in enumerate(labs):
            if runs and runs[-1][0] == v:
                runs[-1][2] = i + 1
            else:
                runs.append([v, i, i + 1])

        def dur(r: list) -> int:
            ts = [t for _, t in chars[r[1]:r[2]] if t]
            return ts[-1][1] - ts[0][0] if ts else 0

        while len(runs) > 1:
            short = [k for k in range(len(runs)) if dur(runs[k]) < min_ms]
            if not short:
                break
            k = min(short, key=lambda k: dur(runs[k]))
            if 0 < k < len(runs) - 1 and runs[k - 1][0] == runs[k + 1][0]:
                runs[k - 1:k + 2] = [[runs[k - 1][0], runs[k - 1][1], runs[k + 1][2]]]
                continue
            nb = [j for j in (k - 1, k + 1) if 0 <= j < len(runs)]
            j = max(nb, key=lambda j: dur(runs[j]))
            lo, hi = min(j, k), max(j, k)
            runs[lo:hi + 1] = [[runs[j][0], runs[lo][1], runs[hi][2]]]
        if len(runs) == 1:
            return sent
        cuts = [0]
        for r in runs[1:]:
            b = r[1]
            near = [p for p in range(max(b - 3, cuts[-1] + 1), min(b + 3, len(chars) - 1)) if chars[p][0] in CLAUSE_END]
            cuts.append(min(near, key=lambda p: abs(p + 1 - b)) + 1 if near else b)
        cuts.append(len(chars))
        out: list[dict] = []
        for (spk, _, _), a, b in zip(runs, cuts, cuts[1:]):
            piece = chars[a:b]
            text = "".join(ch for ch, _ in piece).strip()
            if not text:
                continue
            ts = [t for _, t in piece if t]
            prev_end = out[-1]["end"] if out else sent[0]["start"]
            out.append({"start": ts[0][0] if ts else prev_end, "end": ts[-1][1] if ts else prev_end,
                        "text": text, "spk": spk, "ct": [t for _, t in piece]})
        return out or sent

    @staticmethod
    def _spk_major(turns: list[tuple], sent: list[dict]) -> int:
        if not turns:
            return 0
        ov: dict[int, int] = {}
        for c in sent:
            for ts, te, spk in turns:
                o = min(c["end"], te) - max(c["start"], ts)
                if o > 0:
                    ov[spk] = ov.get(spk, 0) + o
        if ov:
            return max(ov, key=ov.get)
        return Engine._spk_at(turns, sent[0]["start"], sent[-1]["end"])

    @staticmethod
    def _clauses(text: str, toks: list[dict], seg_start: int, seg_end: int) -> list[dict]:
        """按 Nano 的逐字时间戳把一段文字切成小句（逗号/句号处），每句带起止时间，ct 是逐字的 (开始, 结束) 或 None。"""
        times: list = [None] * len(text)
        low, i = text.lower(), 0
        for tk in toks:
            w = (tk.get("token") or "").strip().lower()
            if not w:
                continue
            j = low.find(w, i)
            if j < 0 or j - i > 6:
                continue
            st, en = seg_start + int(tk["start_time"] * 1000), seg_start + int(tk["end_time"] * 1000)
            for k in range(j, j + len(w)):
                times[k] = (st, en)
            i = j + len(w)
        out, buf, bt = [], "", []

        def flush():
            nonlocal buf, bt
            lo, hi = len(buf) - len(buf.lstrip()), len(buf.rstrip())
            if hi > lo:
                ts = [t for t in bt[lo:hi] if t]
                prev = out[-1]["end"] if out else seg_start
                out.append({"start": ts[0][0] if ts else prev, "end": ts[-1][1] if ts else prev,
                            "text": buf[lo:hi], "ct": bt[lo:hi]})
            buf, bt = "", []
        for ch, t in zip(text, times):
            buf += ch
            bt.append(t)
            if ch in CLAUSE_END:
                flush()
        flush()
        for c in out:
            c["end"] = max(c["end"], c["start"])
        if out and not any(times):  # 没有时间戳：整段一句
            t = "".join(c["text"] for c in out)
            out = [{"start": seg_start, "end": seg_end, "text": t, "ct": [None] * len(t)}]
        return out

    @staticmethod
    def _spk_at(turns: list[tuple], s: int, e: int) -> int:
        best, best_ov, near, near_d = 0, 0, 0, None
        for ts, te, spk in turns:
            ov = min(e, te) - max(s, ts)
            if ov > best_ov:
                best, best_ov = spk, ov
            d = abs((ts + te) / 2 - (s + e) / 2)
            if near_d is None or d < near_d:
                near, near_d = spk, d
        return best if best_ov > 0 else near

    @staticmethod
    def _paragraphs(sents: list[dict]) -> list[dict]:
        """同一说话人的相邻句子合并成段落（间隔<3s，且段落不超过 60s / 300 字）。"""
        paras = []
        for s in sents:
            spk = int(s.get("spk", 0))
            text = s.get("text", "").strip()
            if not text:
                continue
            last = paras[-1] if paras else None
            if (last and last["spk"] == spk and s["start"] - last["end"] < 3000
                    and s["end"] - last["start"] < 60000 and len(last["text"]) < 300):
                last["end"] = s["end"]
                sep = " " if re.match(r"[A-Za-z0-9]", text) and re.search(r"[A-Za-z0-9.,?!]$", last["text"]) else ""
                if not sep and last["text"][-1] not in CLAUSE_END and last["text"][-1] not in "…—”」）)":
                    sep = "，"  # 上一段末尾没标点（多是识别段的结尾），补逗号免得两句粘成一句
                last["text"] += sep + text
            else:
                paras.append({"spk": spk, "start": int(s["start"]), "end": int(s["end"]), "text": text})
        return paras

    # ---------- 实时转写 ----------
    def live_session(self, pcm_path: Path, hotword: str = "") -> "LiveSession":
        return LiveSession(self, pcm_path, hotword)


class LiveSession:
    """接收 16k/16bit PCM，流式 VAD 切句，句中每秒出一次临时结果，句末出最终结果。
    音频追加写入 pcm 文件，支持同一会议多次录音续写。"""

    CHUNK = 3200  # 200ms
    PARTIAL_EVERY = 1.0

    def __init__(self, engine: Engine, pcm_path: Path, hotword: str):
        self.e = engine
        self.hotword = hotword.strip()
        self.offset = pcm_path.stat().st_size // 2 if pcm_path.exists() else 0  # 续录时的起始样本
        self.written = 0  # 本次会话写入的字节数
        self.f = open(pcm_path, "ab")
        self.vad = engine.new_vad()
        self.cache: dict = {}
        self.audio = np.zeros(0, dtype=np.float32)  # 本次会话的音频（float32）
        self.audio_base = 0  # self.audio[0] 对应本次会话的样本号
        self.pending = np.zeros(0, dtype=np.float32)
        self.fed = 0  # 已送入 VAD 的样本数（本次会话）
        self.seg_start = None  # 当前句开始（ms，本次会话）
        self.last_partial = 0.0
        self.closed = False

    @property
    def total_ms(self) -> int:
        return int((self.offset + self.audio_base + len(self.audio)) / SR * 1000)

    @property
    def file_bytes(self) -> int:
        """pcm 文件现在（含还在写缓冲里的）一共多少字节：断线重连时告诉网页从哪里接着补发。"""
        return self.offset * 2 + self.written

    def _asr(self, beg_ms: int, end_ms: int) -> str:
        a = int(beg_ms * SR / 1000) - self.audio_base
        b = int(end_ms * SR / 1000) - self.audio_base
        return self.e.asr_segment(self.audio[max(a, 0):max(b, 0)], self.hotword)

    def _final(self, beg: int, end: int) -> list[dict]:
        text = self._asr(beg, end)
        out = []
        if text:
            off = int(self.offset / SR * 1000)
            out.append({"type": "final", "start": beg + off, "end": end + off, "text": text})
        # 丢弃已完成句之前的音频，控制内存
        cut = int(end * SR / 1000) - self.audio_base
        if cut > 0:
            self.audio = self.audio[cut:]
            self.audio_base += cut
        return out

    def _vad_step(self, chunk: np.ndarray, is_final: bool) -> list[dict]:
        events = []
        r = self.vad.generate(input=chunk, cache=self.cache, is_final=is_final, chunk_size=200)
        self.fed += len(chunk)
        for beg, end in (r[0]["value"] if r else []):
            if beg >= 0 and end >= 0:
                events += self._final(beg, end)
                self.seg_start = None
            elif beg >= 0:
                self.seg_start = beg
            elif end >= 0 and self.seg_start is not None:
                events += self._final(self.seg_start, end)
                self.seg_start = None
        return events

    def feed(self, data: bytes) -> list[dict]:
        if self.closed or not data:
            return []
        self.f.write(data)
        self.f.flush()  # 确认给网页的字节必须已经交给系统：服务进程崩了也不丢，网页据此删掉本地缓存
        self.written += len(data)
        x = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        self.audio = np.concatenate([self.audio, x])
        self.pending = np.concatenate([self.pending, x])
        events = []
        while len(self.pending) >= self.CHUNK:
            chunk, self.pending = self.pending[:self.CHUNK], self.pending[self.CHUNK:]
            events += self._vad_step(chunk, False)
        now = time.time()
        if self.seg_start is not None and now - self.last_partial >= self.PARTIAL_EVERY:
            self.last_partial = now
            end = int(self.fed / SR * 1000)
            text = self._asr(self.seg_start, end)
            if text:
                off = int(self.offset / SR * 1000)
                events.append({"type": "partial", "start": self.seg_start + off, "end": end + off, "text": text})
        if self.seg_start is None and len(self.audio) > SR * 30:  # 长时间静音，丢弃缓存
            drop = len(self.audio) - SR * 5
            self.audio = self.audio[drop:]
            self.audio_base += drop
        return events

    def finish(self) -> list[dict]:
        if self.closed:
            return []
        # 末块补零到整块：太短的输入会让 FunASR 内部计算 RTF 时除以 0
        tail = np.pad(self.pending, (0, max(0, self.CHUNK - len(self.pending))))
        try:
            events = self._vad_step(tail, True)
        except Exception:  # noqa: BLE001
            log.exception("vad final step")
            events = []
        if self.seg_start is not None:
            events += self._final(self.seg_start, int(self.fed / SR * 1000))
            self.seg_start = None
        self.close()
        return events

    def close(self):
        if not self.closed:
            self.closed = True
            self.f.close()
