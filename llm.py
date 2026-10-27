"""OpenAI 兼容接口的流式调用（百炼 / DeepSeek / 本地 llama-server 通用）。"""
import json
import time
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


THINK_EVERY = 2.0  # 还在思考时，每隔几秒报一次进度


async def chat_stream(p: dict, messages: list[dict], **kw) -> AsyncIterator[str]:
    """只要正文，见 chat_events。"""
    async for kind, v in chat_events(p, messages, **kw):
        if kind == "text":
            yield v


async def chat_events(p: dict, messages: list[dict], temperature: float = 0.3,
                      max_tokens: int = 6000) -> AsyncIterator[tuple[str, object]]:
    """流式返回 ("text", 正文片段)；模型在思考、还没出正文时，每隔约 THINK_EVERY 秒给一次 ("think", 已等的秒数)，
    让页面不至于一分多钟没有动静（DeepSeek V4 实测先想 50–90 秒才出第一个字）。
    输出被长度上限截断、或者一个字正文都没有时抛 LLMError，不把半截内容当成功：
    推理模型（Gemini 2.5、DeepSeek V4 等）的思考也算在 max_tokens 里，上限小了会只写一半，甚至只思考不出正文。"""
    if not p.get("api_key"):
        raise LLMError(f"「{p['name']}」还没有配置 API Key，请在右上角“设置”里填写")
    body = {"model": p["model"], "messages": messages, "stream": True,
            "temperature": temperature, "max_tokens": max_tokens}
    body.update(p.get("extra_body") or {})
    url = p["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {p['api_key']}", "Content-Type": "application/json"}
    flt = _ThinkFilter()
    fin, got = "", False
    t0 = last = time.monotonic()
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
                        fin = str(ch.get("finish_reason") or fin)
                        dd = ch.get("delta") or {}
                        delta = dd.get("content") or ""
                        out = flt.feed(delta) if delta else ""
                        if delta:
                            if out:
                                got = True
                                yield "text", out
                        thinking = (not got) and (dd.get("reasoning") or dd.get("reasoning_content") or (delta and not out))
                        if thinking and time.monotonic() - last >= THINK_EVERY:
                            last = time.monotonic()
                            yield "think", round(last - t0)
        tail = flt.flush()
        if tail:
            got = True
            yield "text", tail
        hint = (f"推理模型的思考也算在上限里：在“设置 · AI 纪要模型”里给「{p['name']}」的额外请求参数填 "
                '{"max_tokens": 32000}（不同模型的上限不同，报错就调小）')
        if fin.lower() in ("length", "max_tokens"):
            raise LLMError(f"「{p['name']}」的输出达到长度上限（max_tokens {body.get('max_tokens')}）被截断了，内容不完整，没有保存。{hint}")
        if not got:
            raise LLMError(f"「{p['name']}」没有返回正文（可能思考就用完了 max_tokens {body.get('max_tokens')}）。{hint}")
    except httpx.ConnectError as e:
        local = any(h in p["base_url"] for h in ("127.0.0.1", "localhost"))
        raise LLMError(f"连不上模型服务 {p['base_url']}：{e}。"
                       + ("本地模型还没启动：在“设置 · AI 纪要模型”里点“启动本地模型”" if local else "请检查网络和接口地址")) from e
    except httpx.HTTPError as e:
        raise LLMError(f"模型请求失败：{type(e).__name__} {e}") from e


async def chat(p: dict, messages: list[dict], **kw) -> str:
    return "".join([s async for s in chat_stream(p, messages, **kw)])
