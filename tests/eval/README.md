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
