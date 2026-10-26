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

这些实验的方案、结果和偏离见 [docs/improvements.md](../../docs/improvements.md)。
