"""OpenAI 兼容接口的流式调用（百炼 / DeepSeek / 本地 llama-server 通用）。"""
import json
import time
from typing import AsyncIterator
from urllib.parse import urlsplit

import httpx


class LLMError(Exception):
    pass


def is_local_url(url: str) -> bool:
    host = (urlsplit(url or "").hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


def _is_reasoning_model(model: str) -> bool:
    m = (model or "").lower()
    return any(tok in m for tok in ("reasoner", "qwq", "deepseek-r1", "-r1", "o1", "o3", "o4-mini", "thinking"))


def _friendly_http_error(status: int, raw: str, prov_name: str) -> str:
    detail = ""
    try:
        j = json.loads(raw)
        if isinstance(j, dict):
            err = j.get("error")
            if isinstance(err, dict) and err.get("message"):
                detail = str(err["message"]).strip()
            elif j.get("message"):
                detail = str(j["message"]).strip()
    except Exception:  # noqa: BLE001
        pass
    if status == 401:
        return f"「{prov_name}」的 API Key 无效或已过期，请在设置里检查"
    if status == 403:
        return f"「{prov_name}」无权访问该模型或账户受限，请检查接口权限"
    if status == 402:
        return f"「{prov_name}」账户余额不足或额度已用完"
    if status == 429:
        return f"「{prov_name}」请求过于频繁或触发限流，请稍后再试"
    if status == 404:
        return f"找不到「{prov_name}」的接口地址或模型名称，请在设置中核对"
    if status >= 500:
        return f"「{prov_name}」服务暂时繁忙（{status}），请稍后再试"
    short = (detail or raw).strip().replace("\n", " ")[:120]
    return f"「{prov_name}」返回异常（{status}）：{short}" if short else f"「{prov_name}」返回异常（{status}）"


class _ThinkFilter:
    """过滤 <think>...</think> 段（部分模型把思考过程放在正文里）。"""

    def __init__(self):
        self.buf = ""
        self.inside = False

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
    输出被长度上限截断、提前断开、或者一个字正文都没有时抛 LLMError，不把半截内容当成功：
    推理模型（Gemini 2.5、DeepSeek V4 等）的思考也算在 max_tokens 里，上限小了会只写一半，甚至只思考不出正文。"""
    if not p.get("api_key"):
        raise LLMError(f"「{p['name']}」还没有配置 API Key，请在设置里填写")
    eff_max_tokens = max_tokens
    if _is_reasoning_model(str(p.get("model") or "")) and max_tokens >= 2000:
        eff_max_tokens = max(max_tokens, 16000)
    body = {"model": p["model"], "messages": messages, "stream": True,
            "temperature": temperature, "max_tokens": eff_max_tokens}
    extra = p.get("extra_body")
    if isinstance(extra, dict):
        body.update(extra)
    body["stream"] = True  # 防止 extra_body 误写 stream:false 导致 SSE 解析不到正文
    url = p["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {p['api_key']}", "Content-Type": "application/json"}
    flt = _ThinkFilter()
    fin, got, saw_done = "", False, False
    t0 = last = time.monotonic()
    timeout = httpx.Timeout(connect=10, read=600, write=60, pool=10)
    local = is_local_url(url)
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=not local) as client:
            async with client.stream("POST", url, json=body, headers=headers) as r:
                if r.status_code != 200:
                    txt = (await r.aread()).decode("utf-8", "ignore")[:500]
                    raise LLMError(_friendly_http_error(r.status_code, txt, str(p.get("name") or "模型")))
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        saw_done = True
                        break
                    try:
                        j = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(j, dict):
                        continue
                    if j.get("error"):
                        err_obj = j["error"]
                        err_msg = err_obj.get("message") if isinstance(err_obj, dict) else str(err_obj)
                        raise LLMError(str(err_msg or err_obj)[:200])
                    for ch in j.get("choices") or []:
                        if not isinstance(ch, dict):
                            continue
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
        hint = "如果使用思考/推理模型，可更换常规模型或联系服务提供方提高输出长度上限"
        if fin.lower() in ("length", "max_tokens"):
            raise LLMError(f"「{p['name']}」的输出达到长度上限（max_tokens {body.get('max_tokens')}）被截断了，内容不完整，没有保存。{hint}")
        if not saw_done and not fin:
            raise LLMError(f"「{p['name']}」的响应提前中断，内容可能不完整，请重试。")
        if not got:
            raise LLMError(f"「{p['name']}」没有返回正文（可能思考用完了长度上限 max_tokens {body.get('max_tokens')}）。{hint}")
    except httpx.ConnectError as e:
        raise LLMError(
            (f"本地模型「{p['name']}」还没启动，请先在设置中启动本地模型" if local else f"连不上模型服务「{p['name']}」，请检查网络与接口地址")
        ) from e
    except httpx.TimeoutException as e:
        raise LLMError(f"「{p['name']}」响应超时，请稍后再试") from e
    except httpx.HTTPError as e:
        raise LLMError(f"请求「{p['name']}」时网络出错，请稍后再试") from e


async def chat(p: dict, messages: list[dict], **kw) -> str:
    return "".join([s async for s in chat_stream(p, messages, **kw)])
