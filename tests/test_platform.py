"""各系统相关的小功能：采音设备列表的解析（macOS avfoundation / Windows DirectShow / Linux PulseAudio、ALSA）、
每个系统用的 ffmpeg 采音参数、本机地址、阻止休眠。不加载语音模型，不碰真实数据，十几秒跑完（大部分时间在 import torch）。

用法：.venv/bin/python tests/test_platform.py
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-plat-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ambient  # noqa: E402
import asr_engine  # noqa: E402
import lan  # noqa: E402

fails = 0


def check(ok, msg):
    global fails
    print(f"{'ok  ' if ok else 'FAIL'}  {msg}")
    fails += not ok


AVF = """[AVFoundation indev @ 0x7f8] AVFoundation video devices:
[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8] [1] Capture screen 0
[AVFoundation indev @ 0x7f8] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8] [0] MacBook Pro麦克风
[AVFoundation indev @ 0x7f8] [1] iPhone麦克风
: Input/output error"""
DSHOW_NEW = r"""[dshow @ 000001c4] "Integrated Camera" (video)
[dshow @ 000001c4]   Alternative name "@device_pnp_\\?\usb#vid_04f2"
[dshow @ 000001c4] "麦克风阵列 (Realtek(R) Audio)" (audio)
[dshow @ 000001c4]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{1}"
[dshow @ 000001c4] "立体声混音 (Realtek(R) Audio)" (audio)
[dshow @ 000001c4] "OBS Virtual Camera" (none)
[in#0 @ 000001c4] Error opening input: Immediate exit requested"""
DSHOW_OLD = r"""[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0x1]  "Integrated Camera"
[dshow @ 0x1]     Alternative name "@device_pnp_\\?\usb"
[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  "Microphone (Realtek High Definition Audio)"
[dshow @ 0x1]     Alternative name "@device_cm_{33D9A762}\wave_{2}"
dummy: Immediate exit requested"""
PULSE = """Auto-detected sources for pulse:
  mn.monitor [Monitor of Null Output] (none)
* alsa_input.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo] (none)
"""
PULSE_DOWN = "Auto-detected sources for pulse:\nCannot list sources: Generic error in an external library\n"
ALSA = """Auto-detected sources for alsa:
  null [Discard all samples (playback) or generate zero samples (capture)] (none)
* hw:CARD=PCH,DEV=0 [HDA Intel PCH, ALC3246 Analog] (none)
"""

check(ambient.parse_avfoundation(AVF) == ["MacBook Pro麦克风", "iPhone麦克风"], "avfoundation：只列音频设备")
check(ambient.parse_dshow(DSHOW_NEW) == ["麦克风阵列 (Realtek(R) Audio)", "立体声混音 (Realtek(R) Audio)"],
      f"DirectShow 新版输出：{ambient.parse_dshow(DSHOW_NEW)}")
check(ambient.parse_dshow(DSHOW_OLD) == ["Microphone (Realtek High Definition Audio)"], "DirectShow 旧版输出（分节）")
check(ambient.parse_sources(PULSE) == ["mn.monitor", "alsa_input.pci-0000_00_1f.3.analog-stereo"], "PulseAudio 设备列表")
check(ambient.parse_sources(PULSE_DOWN) is None, "PulseAudio 连不上 → None（改用 ALSA）")
check(ambient.parse_sources(ALSA) == ["null", "hw:CARD=PCH,DEV=0"], "ALSA 设备列表")

with mock.patch.object(sys, "platform", "darwin"):
    check(ambient.input_args("") == ["-f", "avfoundation", "-i", ":default"], "macOS 默认输入 :default")
    check(ambient.input_args("iPhone麦克风") == ["-f", "avfoundation", "-i", ":iPhone麦克风"], "macOS 指定设备")
with mock.patch.object(sys, "platform", "win32"), mock.patch.object(ambient, "list_devices", lambda: ["麦克风 (USB)", "立体声混音"]):
    check(ambient.input_args("")[-1] == "audio=麦克风 (USB)", "Windows 没选设备 → 列表里第一个")
    check(ambient.input_args("立体声混音")[-1] == "audio=立体声混音", "Windows 指定设备")
with mock.patch.object(sys, "platform", "win32"), mock.patch.object(ambient, "list_devices", lambda: []):
    try:
        ambient.input_args("")
        check(False, "Windows 没有麦克风应报错")
    except RuntimeError as e:
        check("没有找到麦克风" in str(e), f"Windows 没有麦克风 → {e}")
with mock.patch.object(sys, "platform", "linux"):
    with mock.patch.object(ambient, "_linux_backend", lambda: ("pulse", ["mn.monitor"])):
        check(ambient.input_args("") == ["-f", "pulse", "-i", "default"], "Linux PulseAudio 默认输入")
        check(ambient.input_args("mn.monitor") == ["-f", "pulse", "-i", "mn.monitor"], "Linux PulseAudio 指定设备")
    with mock.patch.object(ambient, "_linux_backend", lambda: ("alsa", [])):
        check(ambient.input_args("") == ["-f", "alsa", "-i", "default"], "Linux 没有 PulseAudio → ALSA")

# 真实环境：不报错就行（CI 上没有麦克风，列表多半是空的）
devs = ambient.list_devices()
check(isinstance(devs, list), f"本机 list_devices()：{devs}")
addrs = lan.addresses()
check(isinstance(addrs, list) and (addrs or not os.environ.get("CI")), f"本机地址：{[(a['iface'], a['ip'], a['kind']) for a in addrs]}")
h = ambient.keep_awake()
check(h is None or hasattr(h, "terminate"), f"阻止休眠：{type(h).__name__}")
if h:
    h.terminate()
check(asr_engine.DEVICE in ("cuda", "mps", "cpu"), f"推理设备：{asr_engine.DEVICE}")

print("全部通过" if not fails else f"{fails} 项失败")
sys.exit(1 if fails else 0)
