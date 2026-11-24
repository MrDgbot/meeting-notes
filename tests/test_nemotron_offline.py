"""Nemotron 3 说话人分离的离线/隐私与 MPS 回退单元测试（不下载真实 400MB 模型，CI 离线可跑）。

覆盖：
1. 导入 diarize_nemotron 即关闭 HF 遥测并开启 MPS 回退环境变量；
2. 全部 socket 外联被禁时，缓存命中（local_files_only=True）可零网络请求跑完；
3. 本地无缓存时才回退联网加载，全部失败时给出清晰中文错误；
4. MPS 前向推理抛出 NotImplementedError / RuntimeError 时自动回退到 CPU 重试并返回正确结果。

用法：.venv/bin/python tests/test_nemotron_offline.py
"""
import os
import socket
import sys
import tempfile
import types
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf
import torch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-nemo-off-"))
sys.path.insert(0, str(ROOT))

import diarize_nemotron  # noqa: E402


def _make_wav(tmp: Path, sec: float = 1.0) -> Path:
    wav = tmp / "sample.wav"
    x = np.zeros(int(16000 * sec), dtype=np.float32)
    sf.write(wav, x, 16000)
    return wav


class _FakeProcessor:
    def __call__(self, x, sampling_rate=16000, return_tensors="pt"):
        assert sampling_rate == 16000
        return {"input_features": torch.zeros((1, 80, 128), dtype=torch.float64)}


class _FakeModel:
    def __init__(self, fail_on_mps=None):
        self.device = "cpu"
        self.fail_on_mps = fail_on_mps
        self.forward_devices = []

    def to(self, dev):
        self.device = str(dev)
        return self

    def eval(self):
        return self

    def __call__(self, **kwargs):
        self.forward_devices.append(self.device)
        for v in kwargs.values():
            if hasattr(v, "dtype") and v.is_floating_point():
                assert v.dtype == torch.float32, f"输入应为 float32，实际 {v.dtype}"
        if self.device == "mps" and self.fail_on_mps is not None:
            raise self.fail_on_mps
        # 80 帧 × 2 人：0 说话 0-500ms，1 说话 300-800ms（含重叠）
        logits = torch.full((1, 80, 2), -5.0, dtype=torch.float32)
        logits[0, 0:50, 0] = 5.0
        logits[0, 30:80, 1] = 5.0
        return types.SimpleNamespace(logits=logits)


def test_env_flags_set_on_import():
    assert os.environ.get("HF_HUB_DISABLE_TELEMETRY") == "1", os.environ.get("HF_HUB_DISABLE_TELEMETRY")
    assert os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1", os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK")


def test_offline_zero_network_calls_when_cached():
    tmp = Path(tempfile.mkdtemp(prefix="mn-nemo-wav-"))
    wav = _make_wav(tmp)
    net_calls = []
    load_calls = []

    def deny(*a, **k):
        net_calls.append(a)
        raise OSError("network blocked by test")

    class FakeAutoProcessor:
        @classmethod
        def from_pretrained(cls, model_id, **kw):
            load_calls.append(("processor", model_id, kw))
            assert kw.get("local_files_only") is True, f"应先尝试离线缓存：{kw}"
            return _FakeProcessor()

    class FakeAutoModel:
        @classmethod
        def from_pretrained(cls, model_id, **kw):
            load_calls.append(("model", model_id, kw))
            assert kw.get("local_files_only") is True, f"应先尝试离线缓存：{kw}"
            return _FakeModel()

    fake_tf = types.SimpleNamespace(
        AutoProcessor=FakeAutoProcessor,
        AutoModelForAudioFrameClassification=FakeAutoModel,
    )
    with mock.patch.dict(sys.modules, {"transformers": fake_tf}), \
         mock.patch.object(socket.socket, "connect", deny), \
         mock.patch.object(socket.socket, "connect_ex", deny), \
         mock.patch.object(socket, "create_connection", deny), \
         mock.patch.object(socket, "getaddrinfo", deny), \
         mock.patch.object(torch.cuda, "is_available", return_value=False), \
         mock.patch.object(torch.backends.mps, "is_available", return_value=False):
        res = diarize_nemotron.diarize(str(wav), num_spk=0)

    assert net_calls == [], f"离线缓存命中时不应发起任何网络连接：{net_calls}"
    assert len(load_calls) == 2 and all(c[2].get("local_files_only") is True for c in load_calls)
    assert res["device"] == "cpu"
    assert res["speakers"] == 2
    assert len(res["turns"]) == 2


def test_cache_miss_falls_back_to_online_then_wraps_error():
    calls = []

    class MissThenOkProc:
        @classmethod
        def from_pretrained(cls, model_id, **kw):
            calls.append(("proc", kw.get("local_files_only", False)))
            if kw.get("local_files_only"):
                raise OSError("not in local cache")
            return _FakeProcessor()

    class MissThenOkModel:
        @classmethod
        def from_pretrained(cls, model_id, **kw):
            calls.append(("model", kw.get("local_files_only", False)))
            if kw.get("local_files_only"):
                raise OSError("not in local cache")
            return _FakeModel()

    fake_tf = types.SimpleNamespace(
        AutoProcessor=MissThenOkProc,
        AutoModelForAudioFrameClassification=MissThenOkModel,
    )
    with mock.patch.dict(sys.modules, {"transformers": fake_tf}):
        proc, model = diarize_nemotron._load_model()
    assert isinstance(proc, _FakeProcessor) and isinstance(model, _FakeModel)
    assert calls[0] == ("proc", True) and ("proc", False) in calls and ("model", False) in calls

    class AlwaysFail:
        @classmethod
        def from_pretrained(cls, model_id, **kw):
            raise OSError("offline")

    fake_tf_fail = types.SimpleNamespace(
        AutoProcessor=AlwaysFail,
        AutoModelForAudioFrameClassification=AlwaysFail,
    )
    with mock.patch.dict(sys.modules, {"transformers": fake_tf_fail}):
        try:
            diarize_nemotron._load_model()
            assert False, "联网与离线均失败时应抛出 RuntimeError"
        except RuntimeError as e:
            assert "加载 Nemotron 3 Diarization 失败" in str(e)


def test_mps_forward_fallback_to_cpu():
    tmp = Path(tempfile.mkdtemp(prefix="mn-nemo-mps-"))
    wav = _make_wav(tmp)

    for exc in (NotImplementedError("MPS op not implemented"), RuntimeError("MPS backend failure")):
        fake_model = _FakeModel(fail_on_mps=exc)
        fake_proc = _FakeProcessor()

        def fake_prepare(inputs, dev, torch_mod):
            # 不依赖真机 MPS 设备分配，仅把输入留在 CPU 并在模型内校验 device 切换
            return {k: v.to(dtype=torch_mod.float32) for k, v in inputs.items()}

        with mock.patch.object(diarize_nemotron, "_load_model", return_value=(fake_proc, fake_model)), \
             mock.patch.object(diarize_nemotron, "_prepare_inputs", side_effect=fake_prepare), \
             mock.patch.object(torch.cuda, "is_available", return_value=False), \
             mock.patch.object(torch.backends.mps, "is_available", return_value=True):
            res = diarize_nemotron.diarize(str(wav), num_spk=0)

        assert res["device"] == "cpu", f"MPS 前向失败后应退回 cpu：{res}"
        assert fake_model.forward_devices == ["mps", "cpu"], fake_model.forward_devices
        assert res["speakers"] == 2 and len(res["turns"]) == 2


def test_cpu_forward_error_is_not_swallowed():
    tmp = Path(tempfile.mkdtemp(prefix="mn-nemo-cpu-"))
    wav = _make_wav(tmp)

    class BoomModel(_FakeModel):
        def __call__(self, **kwargs):
            raise RuntimeError("real cpu failure")

    with mock.patch.object(diarize_nemotron, "_load_model", return_value=(_FakeProcessor(), BoomModel())), \
         mock.patch.object(torch.cuda, "is_available", return_value=False), \
         mock.patch.object(torch.backends.mps, "is_available", return_value=False):
        try:
            diarize_nemotron.diarize(str(wav), num_spk=0)
            assert False, "CPU 上的前向异常不应被吞掉"
        except RuntimeError as e:
            assert "real cpu failure" in str(e)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  ", name)
    print("全部通过")
