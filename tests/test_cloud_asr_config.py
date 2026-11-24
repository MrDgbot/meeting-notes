"""云端识别的配置开关：没配置时不可用、不出现在选项里、不发任何网络请求；配好了才出现。临时数据目录，不碰真实数据。

用法：.venv/bin/python tests/test_cloud_asr_config.py      （约 10 秒，大部分时间在 import torch）
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-cloudcfg-"))
os.environ.pop("DOUBAO_CONFIG", None)
sys.path.insert(0, str(ROOT))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import app  # noqa: E402
import doubao_asr  # noqa: E402

fails: list[str] = []
_STANDALONE = False

FULL_CFG = {
    "ws_url": "wss://example.invalid/ws",
    "register_url": "https://example.invalid/reg",
    "user_agent": "ua",
    "app_key": "k",
    "app": {"aid": "1", "app_name": "x"},
    "device": {"os": "test"},
}


def check(name: str, ok: bool, detail: str = ""):
    print(("ok   " if ok else "FAIL ") + name + (f"  {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)
        if not _STANDALONE:
            raise AssertionError(f"{name}: {detail}" if detail else name)


def test_doubao_config_validation_and_no_network():
    check("import 时不加载 libopus", doubao_asr._opus is None)
    with tempfile.TemporaryDirectory(prefix="mn-cloudcfg-") as td:
        cfg_path = Path(td) / "doubao.json"
        sent = []

        def fake_post(*a, **k):
            sent.append(a)
            raise AssertionError("不该发请求")

        with mock.patch.object(doubao_asr, "CONFIG_FILE", cfg_path), mock.patch.object(httpx, "post", fake_post):
            check("没有配置文件 → config() 是 None", doubao_asr.config() is None)
            try:
                doubao_asr.recognize_many([np.zeros(16000, dtype=np.float32)])
                check("没配置 → recognize_many 直接报错", False, "没有报错")
            except doubao_asr.DoubaoError as e:
                check("没配置 → recognize_many 直接报错", "没有配置" in str(e), str(e))
            check("没配置 → 没发网络请求", not sent)

            cfg_path.write_text(json.dumps({**FULL_CFG, "app": {"aid": "1"}}))
            check("缺字段（app_name）→ 仍不可用", doubao_asr.config() is None)
            cfg_path.write_text("{坏的 json")
            check("文件损坏 → 不可用", doubao_asr.config() is None)
            cfg_path.write_text(json.dumps(FULL_CFG))
            check("字段齐全 → 可用", doubao_asr.config() == FULL_CFG)


def test_doubao_asr_settings_toggle():
    with tempfile.TemporaryDirectory(prefix="mn-cloudcfg-") as td:
        cfg_path = Path(td) / "doubao.json"
        with mock.patch.object(doubao_asr, "CONFIG_FILE", cfg_path):
            check("没配置 → 选项里没有云端", "doubao" not in app.get_asr()["options"])
            try:
                app.put_asr({"model": "doubao"})
                check("没配置 → 不能选云端", False, "被接受了")
            except HTTPException as e:
                check("没配置 → 不能选云端", e.status_code == 400)
            check("本机模型照常可选", {"nano", "paraformer"} <= set(app.get_asr()["options"]))
            cfg_path.write_text(json.dumps(FULL_CFG))
            check("配好了 → 选项里有云端", "doubao" in app.get_asr()["options"])


if __name__ == "__main__":
    _STANDALONE = True
    fails.clear()
    test_doubao_config_validation_and_no_network()
    test_doubao_asr_settings_toggle()
    print("\n全部通过" if not fails else f"\n{len(fails)} 项失败：{fails}")
    sys.exit(1 if fails else 0)
