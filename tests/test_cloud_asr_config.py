"""云端识别的配置开关：没配置时不可用、不出现在选项里、不发任何网络请求；配好了才出现。临时数据目录，不碰真实数据。

用法：.venv/bin/python tests/test_cloud_asr_config.py      （约 10 秒，大部分时间在 import torch）
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="mn-cloudcfg-"))
os.environ["MEETING_DATA"] = str(tmp)
os.environ.pop("HANBAO_CONFIG", None)
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import hanbao_asr  # noqa: E402

fails = []


def check(name: str, ok: bool, detail: str = ""):
    print(("ok   " if ok else "FAIL ") + name + (f"  {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)


check("import 时不加载 libopus", hanbao_asr._opus is None)
check("没有配置文件 → config() 是 None", hanbao_asr.config() is None)

# 没配置时不能发出任何网络请求
sent = []
httpx.post = lambda *a, **k: sent.append(a) or (_ for _ in ()).throw(AssertionError("不该发请求"))
try:
    hanbao_asr.recognize_many([np.zeros(16000, dtype=np.float32)])
    check("没配置 → recognize_many 直接报错", False, "没有报错")
except hanbao_asr.HanbaoError as e:
    check("没配置 → recognize_many 直接报错", "没有配置" in str(e), str(e))
check("没配置 → 没发网络请求", not sent)

cfg_path = tmp / "hanbao.json"
full = {"ws_url": "wss://example.invalid/ws", "register_url": "https://example.invalid/reg", "user_agent": "ua",
        "app_key": "k", "app": {"aid": "1", "app_name": "x"}, "device": {"os": "test"}}
cfg_path.write_text(json.dumps({**full, "app": {"aid": "1"}}))
check("缺字段（app_name）→ 仍不可用", hanbao_asr.config() is None)
cfg_path.write_text("{坏的 json")
check("文件损坏 → 不可用", hanbao_asr.config() is None)
cfg_path.write_text(json.dumps(full))
check("字段齐全 → 可用", hanbao_asr.config() == full)
cfg_path.unlink()

# 设置接口：没配置时不出现云端选项，也不能选
import app  # noqa: E402

check("没配置 → 选项里没有云端", "hanbao" not in app.get_asr()["options"])
try:
    app.put_asr({"model": "hanbao"})
    check("没配置 → 不能选云端", False, "被接受了")
except HTTPException as e:
    check("没配置 → 不能选云端", e.status_code == 400)
check("本机模型照常可选", {"nano", "paraformer"} <= set(app.get_asr()["options"]))
cfg_path.write_text(json.dumps(full))
check("配好了 → 选项里有云端", "hanbao" in app.get_asr()["options"])

print("\n全部通过" if not fails else f"\n{len(fails)} 项失败：{fails}")
sys.exit(1 if fails else 0)
