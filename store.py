"""会议数据的本地文件存储：data/meetings/<id>/ 下放 meta.json、音频、转写、纪要等。"""
import json
import os
import random
import shutil
import string
import threading
import time
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MEETING_DATA") or BASE / "data")  # 测试时可指到别的目录，不碰真实数据
MEETINGS = DATA / "meetings"
MEETINGS.mkdir(parents=True, exist_ok=True)

_lock = threading.RLock()


def read_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def mdir(mid: str) -> Path:
    if not mid or "/" in mid or ".." in mid:
        raise ValueError("bad id")
    return MEETINGS / mid


def exists(mid: str) -> bool:
    try:
        return (mdir(mid) / "meta.json").exists()
    except ValueError:
        return False


def create(title: str = "", **fields) -> dict:
    now = datetime.now()
    mid = now.strftime("%Y%m%d-%H%M%S-") + "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    d = MEETINGS / mid
    d.mkdir(parents=True)
    meta = {
        "id": mid,
        "title": title.strip() or now.strftime("会议 %m-%d %H:%M"),
        "title_auto": not title.strip(),
        "created": now.isoformat(timespec="seconds"),
        "status": "new",  # new | recording | queued | transcribing | ready | error
        "source": "",  # mic | upload
        "duration": 0.0,
        "num_spk": 0,
        "hotword": "",
        "template": "general",
        "speakers": {},  # "0" -> "张三"
        "error": "",
    }
    meta.update({k: v for k, v in fields.items() if v is not None})
    write_json(d / "meta.json", meta)
    return meta


def get(mid: str) -> dict | None:
    return read_json(mdir(mid) / "meta.json")


def update(mid: str, **fields) -> dict:
    with _lock:
        meta = get(mid)
        if meta is None:
            raise KeyError(mid)
        meta.update(fields)
        write_json(mdir(mid) / "meta.json", meta)
        return meta


def list_all() -> list[dict]:
    out = []
    for d in MEETINGS.iterdir():
        m = read_json(d / "meta.json")
        if m:
            out.append(m)
    out.sort(key=lambda m: m["created"], reverse=True)
    return out


def delete(mid: str) -> None:
    shutil.rmtree(mdir(mid), ignore_errors=True)


def load(mid: str, name: str, default=None):
    return read_json(mdir(mid) / name, default)


def save(mid: str, name: str, obj) -> None:
    write_json(mdir(mid) / name, obj)


# ---------- 设置（LLM 提供方） ----------
SETTINGS = DATA / "settings.json"

DEFAULT_SETTINGS = {
    "active": "dashscope",
    "providers": [
        {
            "id": "dashscope",
            "name": "阿里百炼（通义千问）",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key": "",
            "env_key": "DASHSCOPE_API_KEY",
            "model": "qwen-plus",
            "max_input_chars": 100000,
            "extra_body": {"enable_thinking": False},
        },
        {
            "id": "deepseek",
            "name": "DeepSeek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "",
            "env_key": "DEEPSEEK_API_KEY",
            "model": "deepseek-chat",
            "max_input_chars": 80000,
            "extra_body": {},
        },
        {
            "id": "local",
            "name": "本地 Qwen3.8-Flash-Next（llama-server）",
            "base_url": "http://127.0.0.1:8090/v1",
            "api_key": "local",
            "env_key": "",
            "model": "qwen3.8-flash-next",
            "max_input_chars": 18000,
            "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
        },
    ],
}


def get_settings() -> dict:
    s = read_json(SETTINGS)
    if not s:
        s = json.loads(json.dumps(DEFAULT_SETTINGS))
        write_json(SETTINGS, s)
    elif "providers" not in s:  # 文件缺项（手改过、旧版本）：补上默认的接口列表，用户删掉的接口不会被补回
        s["providers"] = json.loads(json.dumps(DEFAULT_SETTINGS["providers"]))
        s.setdefault("active", DEFAULT_SETTINGS["active"])
        write_json(SETTINGS, s)
    return s


def save_settings(s: dict) -> None:
    write_json(SETTINGS, s)


def restore_default_providers() -> int:
    """把被删掉的默认接口加回来（已有的不动），返回加回了几个。"""
    s = get_settings()
    have = {p["id"] for p in s["providers"]}
    add = [json.loads(json.dumps(p)) for p in DEFAULT_SETTINGS["providers"] if p["id"] not in have]
    s["providers"] += add
    if not any(p["id"] == s.get("active") for p in s["providers"]):
        s["active"] = s["providers"][0]["id"]
    save_settings(s)
    return len(add)


def provider(pid: str | None = None) -> dict:
    s = get_settings()
    if not s["providers"]:
        raise KeyError("还没有配置 AI 模型接口，请在“设置”里添加或恢复默认接口")
    pid = pid or s.get("active")
    for p in s["providers"]:
        if p["id"] == pid:
            p = dict(p)
            if not p.get("api_key") and p.get("env_key"):
                p["api_key"] = os.environ.get(p["env_key"], "")
            return p
    raise KeyError(f"找不到模型接口「{pid}」，可能已被删除，请在“设置”里重新选择")


def now_ts() -> float:
    return time.time()
