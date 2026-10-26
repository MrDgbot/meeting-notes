"""说话人分离子进程（diarize_worker.py，pyannote）的隐私测试：模型下载好以后，断网也要能跑完，而且一次网络连接都不发起
（pyannote 默认会把用法统计发到 otel.pyannote.ai，huggingface/modelscope 加载时也可能去查更新）。

做法：先在有网时确保模型已下载；再开一个子进程，把 socket 的连接函数全换成“记下来并报错”，跑一遍 diarize。
测试音频：macOS 上用系统语音合成两个人轮流说话；其他系统用合成的断续音（只检查不联网，不检查分出几个人）。

用法：.venv/bin/python tests/test_diarize_offline.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]


def make_audio(d: Path) -> tuple[Path, bool]:
    wav = d / "two.wav"
    try:
        return _say_audio(d, wav)
    except (OSError, subprocess.CalledProcessError, ValueError):  # 没有 say、没有这两个中文语音、生成的是静音
        pass
    r = np.random.default_rng(0)
    t = np.arange(16000 * 20) / 16000
    x = (0.1 * np.sin(2 * np.pi * 180 * t) * (np.sin(2 * np.pi * 0.5 * t) > 0) + 0.01 * r.normal(size=t.size)).astype(np.float32)
    sf.write(wav, x, 16000)
    return wav, False


def _say_audio(d: Path, wav: Path) -> tuple[Path, bool]:
    if not (shutil.which("say") and shutil.which("ffmpeg")):
        raise OSError("no say")
    parts = []
    for i, (voice, text) in enumerate([("Tingting", "我们先看一下这个季度的数据，销售额比上个月高了一些。"),
                                       ("Meijia", "对，不过成本也涨了，利润其实没怎么变。"),
                                       ("Tingting", "那下个月的预算要不要再调一下？"),
                                       ("Meijia", "可以，我回去先算一个方案，周五发给大家。")]):
        aiff = d / f"{i}.aiff"
        subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True, capture_output=True)
        out = d / f"{i}.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(aiff), "-ar", "16000", "-ac", "1", str(out)], check=True)
        x, _ = sf.read(out, dtype="float32")
        parts += [x, np.zeros(8000, np.float32)]
    x = np.concatenate(parts)
    if np.abs(x).max() <= 0.01:
        raise ValueError("say 生成的是静音")
    sf.write(wav, x, 16000)
    return wav, True


BLOCKED = r"""
import json, os, socket, sys
calls = []
def deny(*a, **k):
    calls.append(repr(a[1:] if a and isinstance(a[0], socket.socket) else a)[:120])
    raise OSError("network blocked by test")
socket.socket.connect = deny
socket.socket.connect_ex = deny
socket.create_connection = deny
socket.getaddrinfo = deny
sys.path.insert(0, sys.argv[1])
import diarize_worker
r = diarize_worker.diarize(sys.argv[2], 0)
print(json.dumps({"calls": calls, "turns": r["turns"], "metrics": os.environ.get("PYANNOTE_METRICS_ENABLED")}))
"""


def main():
    d = Path(tempfile.mkdtemp(prefix="mn-diar-"))
    wav, speech = make_audio(d)
    # 1) 有网：确保模型已经下载（第一次会下约 31 MB）
    subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {str(ROOT)!r}); import diarize_worker; print(diarize_worker.model_dir())"],
                   check=True, capture_output=True, text=True)
    # 2) 断网跑一遍
    p = subprocess.run([sys.executable, "-c", BLOCKED, str(ROOT), str(wav)], capture_output=True, text=True, timeout=900)
    assert p.returncode == 0, "断网时说话人分离失败：\n" + p.stderr[-2000:]
    r = json.loads(p.stdout.strip().splitlines()[-1])
    assert r["calls"] == [], f"断网时还在尝试联网：{r['calls'][:5]}"
    assert r["metrics"] == "false", r["metrics"]
    print("ok 断网能跑完，没有发起任何网络连接；pyannote 用法统计已关闭")
    if speech:
        spk = {t[2] for t in r["turns"]}
        assert r["turns"], "两个人说话的测试音频，一段说话人都没分出来"
        print(f"ok 测试音频分出 {len(r['turns'])} 段、{len(spk)} 个说话人")
    print("全部通过")


if __name__ == "__main__":
    main()
