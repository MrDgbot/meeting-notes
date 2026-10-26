"""OpenAI 兼容接口的流式调用（百炼 / DeepSeek / 本地 llama-server 通用）。"""
import json
from typing import AsyncIterator

import httpx


class LLMError(Exception):
    pass


class _ThinkFilter:
    """过滤 <think>...</think> 段（部分模型把思考过程放在正文里）。"""

    def __init__(self):
        self.buf = ""
        self.inside = False
        self.started = False

    def feed(self, s: str) -> str:
        self.buf += s
        out = ""
        while True:
            if self.inside:
                i = self.buf.find("</think>")
                if i < 0:
                    self.buf = self.buf[-10:]
                    return out
                self.buf = self.buf[i + 8:]
                self.inside = False
            else:
                i = self.buf.find("<think>")
                if i >= 0:
                    out += self.buf[:i]
                    self.buf = self.buf[i + 7:]
                    self.inside = True
                    continue
                # 保留可能是 "<think" 前缀的尾巴
                keep = 0
                for k in range(1, 7):
                    if self.buf.endswith("<think>"[:k]):
                        keep = k
                out += self.buf[: len(self.buf) - keep]
                self.buf = self.buf[len(self.buf) - keep:]
                return out

    def flush(self) -> str:
        out = "" if self.inside else self.buf
        self.buf = ""
        return out


async def chat_stream(p: dict, messages: list[dict], temperature: float = 0.3,
                      max_tokens: int = 6000) -> AsyncIterator[str]:
    if not p.get("api_key"):
        raise LLMError(f"「{p['name']}」还没有配置 API Key，请在右上角“设置”里填写")
    body = {"model": p["model"], "messages": messages, "stream": True,
            "temperature": temperature, "max_tokens": max_tokens}
    body.update(p.get("extra_body") or {})
    url = p["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {p['api_key']}", "Content-Type": "application/json"}
    flt = _ThinkFilter()
    timeout = httpx.Timeout(connect=10, read=600, write=60, pool=10)
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            async with client.stream("POST", url, json=body, headers=headers) as r:
                if r.status_code != 200:
                    txt = (await r.aread()).decode("utf-8", "ignore")[:500]
                    raise LLMError(f"模型接口返回 {r.status_code}: {txt}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        j = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if j.get("error"):
                        raise LLMError(str(j["error"])[:500])
                    for ch in j.get("choices") or []:
                        delta = (ch.get("delta") or {}).get("content") or ""
                        if delta:
                            out = flt.feed(delta)
                            if out:
                                yield out
        tail = flt.flush()
        if tail:
            yield tail
    except httpx.ConnectError as e:
        local = any(h in p["base_url"] for h in ("127.0.0.1", "localhost"))
        raise LLMError(f"连不上模型服务 {p['base_url']}：{e}。"
                       + ("本地模型还没启动：在“设置 · AI 纪要模型”里点“启动本地模型”" if local else "请检查网络和接口地址")) from e
    except httpx.HTTPError as e:
        raise LLMError(f"模型请求失败：{type(e).__name__} {e}") from e


async def chat(p: dict, messages: list[dict], **kw) -> str:
    return "".join([s async for s in chat_stream(p, messages, **kw)])
