"""大模型流式输出的收尾判断：正常结束照常返回；被长度上限截断、或者一个字正文都没有时报错，不把半截内容当成功。

  .venv/bin/python tests/test_llm_stream.py
在本机起一个假的 OpenAI 兼容接口，按请求里的 model 名返回不同的流（几秒，不联网）。
"""
import asyncio
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import llm  # noqa: E402
from llm import LLMError, chat, chat_events, chat_stream  # noqa: E402


def chunk(content=None, reasoning=None, finish=None):
    d = {k: v for k, v in (("content", content), ("reasoning", reasoning)) if v is not None}
    return {"choices": [{"index": 0, "delta": d, "finish_reason": finish}]}


STREAMS = {
    "ok": [chunk(reasoning="想一想"), chunk("你"), chunk("好"), chunk(finish="stop")],
    "cut": [chunk("# 纪要\n"), chunk("| 事项 | 负责人 |\n|---"), chunk("-" * 50, finish="length")],
    "cut-gemini": [chunk("写到一半", finish="max_tokens")],          # 有的网关把 Gemini 的截断原样写成 max_tokens
    "think-only": [chunk(reasoning="想了很久") for _ in range(5)] + [chunk(finish="length")],
    "empty-stop": [chunk(reasoning="想完了"), chunk(finish="stop")],
    "think-tag": [chunk("<think>都在思考标签里"), chunk("还没想完", finish="length")],
    "slow-think": ["sleep"] + [chunk(reasoning="嗯") for _ in range(3)] + ["sleep", chunk(reasoning="想好了"), chunk("答案"), chunk(finish="stop")],
    "slow-tag": ["sleep", chunk("<think>想"), "sleep", chunk("好了</think>答案"), chunk(finish="stop")],
}
SEEN = []


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for c in STREAMS[body["model"]]:
            if c == "sleep":
                time.sleep(0.25)
                continue
            self.wfile.write(f"data: {json.dumps(c, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/v1"
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += not cond


def prov(model, extra=None):
    return {"name": "测试接口", "base_url": URL, "api_key": "k", "model": model, "extra_body": extra or {}}


async def collect(model, extra=None, **kw):
    out = []
    try:
        async for d in chat_stream(prov(model, extra), [{"role": "user", "content": "hi"}], **kw):
            out.append(d)
        return "".join(out), None
    except LLMError as e:
        return "".join(out), str(e)


async def main():
    text, err = await collect("ok")
    check(text == "你好" and err is None, f"正常结束：返回正文，不带思考过程（{text!r}）")
    text, err = await collect("cut", max_tokens=6000)
    check(err is not None and "截断" in err and "6000" in err and "max_tokens" in err, f"finish_reason=length：报错并说明上限（{err}）")
    check(text.startswith("# 纪要"), "截断前已经流出去的内容照常流出（页面上能看到写到了哪里）")
    _, err = await collect("cut-gemini")
    check(err is not None and "截断" in err, "finish_reason=max_tokens 也算截断")
    _, err = await collect("think-only")
    check(err is not None and "截断" in err, "只思考、没出正文就到上限：报错")
    text, err = await collect("empty-stop")
    check(err is not None and "没有返回正文" in err and text == "", f"正常结束但一个字正文都没有：报错（{err}）")
    _, err = await collect("think-tag")
    check(err is not None, "正文全在 <think> 里就被截断：报错")
    SEEN.clear()
    _, err = await collect("ok", extra={"max_tokens": 32000}, max_tokens=20)
    check(err is None and SEEN[-1]["max_tokens"] == 32000, "接口的额外请求参数能覆盖调用处的 max_tokens（推理模型靠它放宽上限）")
    try:
        await chat(prov("cut"), [{"role": "user", "content": "hi"}])
        check(False, "chat()：截断时也报错")
    except LLMError:
        check(True, "chat()（分段提炼、测试接口用的）截断时也报错，不拿半截内容去拼纪要")
    llm.THINK_EVERY = 0.2
    for model in ("slow-think", "slow-tag"):
        ev = [e async for e in chat_events(prov(model), [{"role": "user", "content": "hi"}])]
        kinds = [k for k, _ in ev]
        text = "".join(v for k, v in ev if k == "text")
        check("think" in kinds and kinds.index("think") < kinds.index("text") and text == "答案",
              f"{model}：没出正文前报思考进度，出了正文后不再报（{kinds}）")
        check([k for k in kinds[kinds.index("text"):]] == ["text"] * kinds[kinds.index("text"):].count("text"), f"{model}：正文开始后只有正文")
    text, err = await collect("slow-think")
    check(text == "答案" and err is None, "chat_stream 不受影响：只给正文")


asyncio.run(main())
srv.shutdown()
print("全部通过" if not fails else f"{fails} 项失败")
sys.exit(1 if fails else 0)
