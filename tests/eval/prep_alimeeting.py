"""把 AliMeeting 的一个子集（Eval_Ali / Test_Ali）整理成评测用的文件。

  tests/eval/.venv/bin/python tests/eval/prep_alimeeting.py ~/datasets/AliMeeting/Test_Ali ~/eval-data/ali-test

- wav/<会议>.wav：远场 8 路麦克风取第 1 路（和 M2MeT 基线、pyannote 的“channel 1”一样），16k 单声道。
- ref/<会议>.rttm：用 M2MeT 主办方仓库里的 make_textgrid_rttm.py 生成（不自己写转换）。
- ref/<会议>.stm：每句话的说话人、起止、文字；文字先过主办方的 text_normalize.pl（去掉 <sil> 等标记）。
"""
import subprocess
import sys
from pathlib import Path

import textgrid

OFFICIAL = Path.home() / "tools/AliMeeting/repo"
src, dst = Path(sys.argv[1]).expanduser(), Path(sys.argv[2]).expanduser()
far = next(src.glob("*_far"))
(dst / "wav").mkdir(parents=True, exist_ok=True)
(dst / "ref").mkdir(parents=True, exist_ok=True)
tgs = {p.stem: p for p in (far / "textgrid_dir").glob("*.TextGrid")}
for wav in sorted((far / "audio_dir").glob("*.wav")):
    sess = wav.stem
    tg = tgs.get(sess) or tgs.get("_".join(sess.split("_")[:2]))
    if not tg:
        print("没有标注，跳过", sess)
        continue
    out_wav = dst / "wav" / f"{sess}.wav"
    if not out_wav.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-af", "pan=mono|c0=c0", "-ar", "16000",
                        "-c:a", "pcm_s16le", str(out_wav)], check=True)
    subprocess.run([sys.executable, str(OFFICIAL / "speaker/local/make_textgrid_rttm.py"), "--input_textgrid_file", str(tg),
                    "--output_rttm_file", str(dst / "ref" / f"{sess}.rttm"), "--uttid", sess], check=True)
    rows = []
    for tier in textgrid.TextGrid.fromFile(str(tg)):
        for iv in tier:
            if iv.mark and iv.mark.strip():
                rows.append((iv.minTime, iv.maxTime, tier.name, iv.mark.strip()))
    rows.sort()
    lines = "".join(f"u{i} {t}\n" for i, (_, _, _, t) in enumerate(rows))
    norm = subprocess.run(["perl", str(OFFICIAL / "asr/local/text_normalize.pl")], input=lines, capture_output=True,
                          text=True, check=True).stdout.splitlines()
    texts = {ln.split(" ", 1)[0]: (ln.split(" ", 1)[1] if " " in ln else "") for ln in norm}
    with open(dst / "ref" / f"{sess}.stm", "w", encoding="utf-8") as f:
        for i, (a, b, spk, _) in enumerate(rows):
            f.write(f"{sess} 1 {spk} {a:.2f} {b:.2f} {texts.get(f'u{i}', '').replace(' ', '')}\n")
    print(sess, "参考说话人", len({r[2] for r in rows}), "句", len(rows), flush=True)
