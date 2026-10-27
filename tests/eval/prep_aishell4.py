"""从 stdin 读 AISHELL-4 的 tar.gz 流，边下边解：wav 只留第 1 路（16k 单声道 int16），TextGrid / rttm 原样存。不落地整个压缩包（磁盘不够）。
  curl -s https://openslr.trmal.net/resources/111/train_L.tar.gz | .venv/bin/python tests/eval/prep_aishell4.py ~/eval-data/aishell4/train_L
（test.tar.gz 同理，输出到 ~/eval-data/aishell4/test）"""
import io, sys, tarfile, time
from pathlib import Path
import soundfile as sf
out = Path(sys.argv[1]); (out / "wav").mkdir(parents=True, exist_ok=True); (out / "ref").mkdir(parents=True, exist_ok=True)
t0 = time.time(); n = 0
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as tf:
    for m in tf:
        if not m.isfile():
            continue
        name = Path(m.name).name
        data = tf.extractfile(m).read()
        if name.endswith((".wav", ".flac")):
            x, sr = sf.read(io.BytesIO(data), dtype="int16", always_2d=True)
            assert sr == 16000, sr
            sf.write(out / "wav" / (Path(name).stem + ".wav"), x[:, 0], sr, subtype="PCM_16")
            n += 1
            print(f"{time.time() - t0:7.0f}s wav {name} {x.shape[0] / sr / 60:.1f} 分钟 {x.shape[1]} 路", flush=True)
        elif name.endswith((".TextGrid", ".rttm")):
            (out / "ref" / name).write_bytes(data)
print("done", n, "wav", flush=True)
