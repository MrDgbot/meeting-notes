# 评测

会议转写和纪要的评测脚本。数据和结果都放在仓库外：`~/eval-data/`（输入、人工标注）、`~/eval-out/`（结果）。

```bash
cd tests/eval && uv venv -p 3.11 .venv && VIRTUAL_ENV=.venv uv pip install meeteval pyannote.metrics jiwer tabulate intervaltree textgrid tqdm simplejson
# 另需：~/tools/SCTK（make config && make all && make install）、~/tools/dscore、~/tools/AliMeeting/repo（M2MeT 主办方仓库）
```

| 脚本 | 用哪个环境 | 做什么 |
|---|---|---|
| `prep_alimeeting.py` | tests/eval/.venv | AliMeeting → 单声道 wav、参考 RTTM（主办方脚本）、参考 STM |
| `run_pipeline.py` | 仓库的 .venv | 用产品的 `Engine.transcribe` 跑转写，存段落、句子、说话人分离结果 |
| `score.py` | tests/eval/.venv | DER（dscore + pyannote）、CER（sclite + jiwer + cer.py）、cpCER（MeetEval） |
| `gen_minutes.py` | 仓库的 .venv | 用产品的纪要接口生成纪要（临时数据目录，不碰真实数据） |
| `split_sweep.py` | 仓库的 .venv | 按说话人拆句（`SPLIT_MIN_MS`）的离线实验：用 run_pipeline 存下的 Nano 原始输出重算 cpCER，不重跑模型 |
| `diag/breakdown2.py` | tests/eval/.venv | 错字按“参考片段和别人重叠的比例”分组（单人 / 部分重叠 / 以重叠为主） |
| `diag/quiet.py`、`diag/vad_exp.py` | 仓库的 .venv | 小声说话人的音量和 VAD 覆盖；只跑 VAD 比较几种音量处理 |
| `overlap/run_pya.py`、`score_pya.py` | 单独的 venv（`pyannote.audio>=4`） | 用 pyannote community-1 跑一批录音、打分 |
| `overlap/merge_eval.py`、`merge_score.py` | 仓库的 .venv / tests/eval/.venv | pyannote 说话人 + CAM++ 声纹合并的离线实验（含合并阈值的几个候选） |
| `overlap/sep_probe_a.py`、`probe_cv.py`、`sep_probe_b.py` | 单独的 venv（speechbrain / clearvoice）+ 仓库的 .venv | 重叠分离的可行性探针：挑真重叠片段 → 分离 → Nano 识别 → 比字错率 |
| `overlap/round2_*.py` | `.venv-saasr`（FunASR 0.8.8）/ `.venv-tse` + 仓库的 .venv | 重叠第二轮：裁窗口、SA-ASR、目标说话人提取，同一批 20 处片段 |
| `spk_embed_r2.py`、`spk_sweep_r2.py`、`spk_score_r2.py` | 仓库的 .venv / 仓库的 .venv / tests/eval/.venv | 第二轮人数判断：照产品现在的音量归一存声纹缓存（含每块原始音量）→ 离线试候选 → 打分（AliMeeting、AISHELL-4、周会） |
| `hotword_suspects.py` | 仓库的 .venv | “可能认错的热词”：在有参考的会上看找得对不对，在 AliMeeting 上数误报 |
| `speed_bench.py` | 仓库的 .venv | 指定一份代码目录，计时会后转写（用来和上一版比速度） |

AISHELL-4（第二轮的开发集 / 留出集）：从 [OpenSLR 111](https://www.openslr.org/111/) 下载 `train_L.tar.gz`、`test.tar.gz`，8 路 flac 取第 1 路存成 16k 单声道 wav（`prep_aishell4.py`，边下边解，不落地压缩包），参考用压缩包里自带的 rttm。

这些实验的方案、结果和偏离见 [docs/improvements.md](../../docs/improvements.md)。
