"""局域网安全加固单元测试（不加载语音模型、不依赖公网，几秒跑完）：
覆盖文件权限原子写、并发登录限速、IPv4-mapped IPv6 归一化、指数退避与 _fails 清理、
畸形 Cookie（Latin-1 '²'）与未来时间戳、异步单飞 Host 校验不阻塞事件循环、
Origin 协议/Sec-Fetch-Site、POST /lan/logout、GET /lan/login 去 ?err=、
PUT /api/lan 先校验再落盘、损坏 CA 自恢复、容器无 ip/ifconfig 回退、EXTRA_HOSTS 写入 SAN。

用法：.venv/bin/python tests/test_lan_hardening.py
"""
import asyncio
import concurrent.futures
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

_TMP = None
if "MEETING_DATA" not in os.environ:
    _TMP = Path(tempfile.mkdtemp(prefix="mn-lan-hard-"))
    os.environ["MEETING_DATA"] = str(_TMP)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography import x509  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import lan  # noqa: E402


def _reset_lan(d: Path) -> None:
    d.mkdir(parents=True, exist_ok=True)
    lan.DIR = d
    lan.CFG = d / "config.json"
    lan.CA_KEY, lan.CA_PEM, lan.SRV_KEY, lan.SRV_PEM = (d / n for n in ("ca.key", "ca.pem", "server.key", "server.pem"))
    lan._cfg = None
    with lan._auth_lock:
        lan._fails.clear()
        lan._all_fails.clear()
        lan._all_lock[0] = 0.0
    with lan._hosts_lock:
        lan._hosts[0] = 0.0
        lan._hosts[1] = set()
        lan._hosts_unknown_ts[0] = 0.0


@contextmanager
def _isolated_lan(prefix: str):
    saved = (lan.DIR, lan.CFG, lan.CA_KEY, lan.CA_PEM, lan.SRV_KEY, lan.SRV_PEM, lan._cfg)
    root = Path(tempfile.mkdtemp(prefix=prefix))
    d = root / "lan"
    try:
        _reset_lan(d)
        yield d
    finally:
        lan.DIR, lan.CFG, lan.CA_KEY, lan.CA_PEM, lan.SRV_KEY, lan.SRV_PEM, lan._cfg = saved
        with lan._auth_lock:
            lan._fails.clear()
            lan._all_fails.clear()
            lan._all_lock[0] = 0.0
        with lan._hosts_lock:
            lan._hosts[0] = 0.0
            lan._hosts[1] = set()
            lan._hosts_unknown_ts[0] = 0.0
        shutil.rmtree(root, ignore_errors=True)


def _make_app() -> FastAPI:
    a = FastAPI()
    a.add_middleware(lan.Guard)
    a.include_router(lan.router)

    @a.get("/api/ping")
    def ping():
        return {"ok": True}

    @a.post("/api/mutate")
    def mutate():
        return {"ok": True}

    return a


def test_atomic_secret_permissions():
    """data/lan 为 0o700，config.json / ca.key / server.key 为 0o600，即使 umask=000 且不留 .tmp。"""
    old_umask = os.umask(0o000) if os.name != "nt" else None
    try:
        with _isolated_lan("mn-perm-") as d:
            lan.set_password("secret-123")
            lan.ensure_certs()
            if os.name != "nt":
                assert stat.S_IMODE(d.stat().st_mode) == 0o700, oct(stat.S_IMODE(d.stat().st_mode))
                for f in (lan.CFG, lan.CA_KEY, lan.SRV_KEY):
                    assert stat.S_IMODE(f.stat().st_mode) == 0o600, (f.name, oct(stat.S_IMODE(f.stat().st_mode)))
            leftover = [p.name for p in d.iterdir() if p.name.endswith(".tmp")]
            assert not leftover, f"残留临时文件：{leftover}"
    finally:
        if old_umask is not None:
            os.umask(old_umask)


def test_valid_token_malformed_and_future():
    """Latin-1 上标数字 '²' 不得抛 ValueError，未来/过期时间戳必须拒绝。"""
    with _isolated_lan("mn-tok-"):
        lan.set_password("secret-123")
        good = lan.make_token()
        assert lan.valid_token(good)
        for bad in (None, "", "nosplit", "².abc", "³.abc", "¹.abc", "٢٠٢٦.abc", "abc.def"):
            assert lan.valid_token(bad) is False, f"应拒绝 {bad!r}"
        future_ts = str(int(time.time()) + 3600)
        assert lan.valid_token(f"{future_ts}.{lan._sign(future_ts)}") is False, "未来时间戳应被拒绝"
        old_ts = str(int(time.time()) - lan.MAX_AGE - 10)
        assert lan.valid_token(f"{old_ts}.{lan._sign(old_ts)}") is False, "过期时间戳应被拒绝"
        # 直接向 ASGI Guard 中间件传入原始 Latin-1 字节 0xB2 Cookie：应返回 401 而非 500
        app = _make_app()
        guard = lan.Guard(app)
        sent = []

        async def run_guard():
            scope = {
                "type": "http",
                "scheme": "https",
                "method": "GET",
                "path": "/api/ping",
                "query_string": b"",
                "client": ("192.168.1.99", 54321),
                "headers": [(b"host", b"127.0.0.1:8771"), (b"cookie", b"mn_lan=\xb2.deadbeef")],
            }

            async def recv():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(msg):
                sent.append(msg)

            await guard(scope, recv, send)

        asyncio.run(run_guard())
        starts = [m for m in sent if m["type"] == "http.response.start"]
        assert starts and starts[0]["status"] == 401, starts


def test_rate_limit_concurrency_and_bounds():
    """并发突发登录不能绕过 5 次锁定；IPv4-mapped IPv6 共用桶；超高计数不炸内存；_fails 有上限与 TTL 清理。"""
    with _isolated_lan("mn-rate-"):
        lan.set_password("correct-pass")
        app = _make_app()
        # 1) 12 线程并发猜错：最多 5 次 401，其余必须 429
        barrier = threading.Barrier(12)

        def attempt():
            c = TestClient(app, base_url="https://127.0.0.1:8771", client=("192.168.1.50", 12345))
            barrier.wait()
            r = c.post("/lan/login", data={"password": "wrong", "next": "/"},
                       headers={"Host": "127.0.0.1:8771", "Origin": "https://127.0.0.1:8771"})
            return r.status_code

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            codes = list(pool.map(lambda _: attempt(), range(12)))
        assert codes.count(401) == 5, f"并发绕过了 5 次限制：{codes}"
        assert codes.count(429) == 7, f"其余请求应为 429：{codes}"

        # 2) IPv4-mapped IPv6 与 IPv4 共用同一个锁定桶
        assert lan._locked("::ffff:192.168.1.50") > 0
        assert lan._locked("192.168.1.50") > 0

        # 3) 超大失败次数指数截断，不能卡死或超出 3600s
        with lan._auth_lock:
            lan._fails["10.1.1.1"] = [100_000, 0.0, time.time()]
            lan._all_fails.clear()
            lan._all_lock[0] = 0.0
        lan._failed("10.1.1.1")
        w = lan._locked("10.1.1.1")
        assert 3500 <= w <= 3600, w

        # 4) TTL 过期清理与 MAX_FAIL_ENTRIES 上限
        with lan._auth_lock:
            lan._fails.clear()
            lan._all_fails.clear()
            lan._all_lock[0] = 0.0
            old = time.time() - lan.FAIL_TTL - 10
            lan._fails["10.2.2.2"] = [4, 0.0, old]
        lan._failed("10.2.2.2")
        with lan._auth_lock:
            assert lan._fails["10.2.2.2"][0] == 1, "超过 TTL 的旧计数应重置"
        for i in range(lan.MAX_FAIL_ENTRIES + 200):
            with lan._auth_lock:
                lan._all_fails.clear()
                lan._all_lock[0] = 0.0
            lan._failed(f"10.{(i >> 16) & 255}.{(i >> 8) & 255}.{i & 255}")
        with lan._auth_lock:
            assert len(lan._fails) <= lan.MAX_FAIL_ENTRIES, len(lan._fails)


def test_async_host_ok_nonblocking_and_cooldown():
    """Guard 异步刷新不阻塞事件循环，并发过期单飞 coalescing，未知 Host 冷却 >= 30s。"""
    with _isolated_lan("mn-host-"):
        calls = 0

        def slow_compute():
            nonlocal calls
            calls += 1
            time.sleep(0.15)
            return {"127.0.0.1", "localhost", "::1"}

        async def run():
            ticks = 0

            async def ticker():
                nonlocal ticks
                for _ in range(5):
                    await asyncio.sleep(0.02)
                    ticks += 1

            scope = {"type": "http", "headers": [(b"host", b"127.0.0.1:8770")]}
            with mock.patch.object(lan, "_compute_allowed_hosts", slow_compute):
                t = asyncio.create_task(ticker())
                results = await asyncio.gather(*(lan.host_ok_async(scope) for _ in range(8)))
                await t
            assert all(results)
            assert calls == 1, f"单飞刷新应只调用 1 次，实际 {calls}"
            assert ticks >= 3, f"事件循环被阻塞（ticker 只跑了 {ticks} 次）"

            # 未知 Host 冷却：先模拟缓存已经旧于 30s，连续发 10 个未知 Host 最多只刷新 1 次
            with lan._hosts_lock:
                lan._hosts[0] = time.time() - 40
                lan._hosts_unknown_ts[0] = 0.0
            bad_scope = {"type": "http", "headers": [(b"host", b"evil.invalid:8770")]}
            before = calls
            with mock.patch.object(lan, "_compute_allowed_hosts", slow_compute):
                out = [await lan.host_ok_async(bad_scope) for _ in range(10)]
            assert not any(out)
            assert calls - before == 1, f"未知 Host 冷却失效，额外刷新了 {calls - before} 次"

        asyncio.run(run())
        # 畸形 host_name 不得误匹配合法地址
        assert lan.host_name("[::1]evil") != "::1"
        assert lan.host_name("127.0.0.1:evil") != "127.0.0.1"
        assert lan.host_name("[::1]:8770") == "::1"
        assert lan.host_name("127.0.0.1:8770") == "127.0.0.1"


def test_origin_scheme_sfs_logout_and_login_err():
    """Origin 必须匹配协议；无 Origin 时 Sec-Fetch-Site: cross-site 拒绝；/lan/logout 只接受 POST；login 忽略 ?err=。"""
    assert lan.origin_ok({"type": "http", "method": "POST", "scheme": "https",
                          "headers": [(b"host", b"192.168.1.5:8771"), (b"origin", b"https://192.168.1.5:8771")]})
    assert not lan.origin_ok({"type": "http", "method": "POST", "scheme": "https",
                              "headers": [(b"host", b"192.168.1.5:8771"), (b"origin", b"http://192.168.1.5:8771")]})
    assert not lan.origin_ok({"type": "websocket", "scheme": "wss",
                              "headers": [(b"host", b"192.168.1.5:8771"), (b"origin", b"http://192.168.1.5:8771")]})
    assert lan.origin_ok({"type": "websocket", "scheme": "ws",
                          "headers": [(b"host", b"127.0.0.1:8770"), (b"origin", b"http://127.0.0.1:8770")]})
    assert not lan.origin_ok({"type": "http", "method": "POST", "scheme": "http",
                              "headers": [(b"host", b"127.0.0.1:8770"), (b"origin", b"javascript://127.0.0.1:8770")]})
    assert not lan.origin_ok({"type": "http", "method": "POST", "scheme": "http",
                              "headers": [(b"host", b"127.0.0.1:8770"), (b"sec-fetch-site", b"cross-site")]})
    assert lan.origin_ok({"type": "http", "method": "POST", "scheme": "http",
                          "headers": [(b"host", b"127.0.0.1:8770"), (b"sec-fetch-site", b"same-origin")]})
    assert lan.origin_ok({"type": "http", "method": "POST", "scheme": "http",
                          "headers": [(b"host", b"127.0.0.1:8770")]})

    with _isolated_lan("mn-csrf-"):
        lan.set_password("secret-123")
        app = _make_app()
        c = TestClient(app, base_url="https://127.0.0.1:8771", client=("192.168.1.50", 12345))
        r_get = c.get("/lan/logout", headers={"Host": "127.0.0.1:8771"}, follow_redirects=False)
        assert r_get.status_code == 405, r_get.status_code
        r_csrf = c.post("/lan/logout", headers={"Host": "127.0.0.1:8771", "Origin": "https://evil.test"}, follow_redirects=False)
        assert r_csrf.status_code == 403, r_csrf.status_code
        r_post = c.post("/lan/logout", headers={"Host": "127.0.0.1:8771", "Origin": "https://127.0.0.1:8771"}, follow_redirects=False)
        assert r_post.status_code == 303 and r_post.headers["location"] == "/lan/login", r_post.status_code

        r_login = c.get("/lan/login?err=PHISH_ALERT", headers={"Host": "127.0.0.1:8771"})
        assert r_login.status_code == 200 and "PHISH_ALERT" not in r_login.text


def test_put_lan_validation_and_atomicity():
    """PUT /api/lan 先校验全部字段再写入；非法端口不改口令不踢设备；省略 enabled 不静默关闭。"""
    with _isolated_lan("mn-put-"):
        lan.set_password("init-pass-1")
        lan._save(enabled=True, port=8775)
        old_cfg = lan.cfg()
        app = _make_app()
        c = TestClient(app, base_url="http://127.0.0.1:8770", client=("127.0.0.1", 12345))

        with mock.patch.object(lan.server, "apply", mock.AsyncMock()) as m_apply:
            # 非法 port + 新口令：应 400 且不改口令/secret
            for bad_port in ("abc", 0, 80, 70000, True, lan.MAIN_PORT):
                r = c.put("/api/lan", json={"password": "new-pass-999", "port": bad_port},
                          headers={"Host": "127.0.0.1:8770", "Origin": "http://127.0.0.1:8770"})
                assert r.status_code == 400, (bad_port, r.status_code, r.text)
            assert lan.cfg()["pw_hash"] == old_cfg["pw_hash"], "端口非法时不应已修改口令"
            assert lan.cfg()["secret"] == old_cfg["secret"], "端口非法时不应轮换 secret"

            # 非字符串 password -> 400
            r = c.put("/api/lan", json={"password": 123456},
                      headers={"Host": "127.0.0.1:8770", "Origin": "http://127.0.0.1:8770"})
            assert r.status_code == 400, r.status_code

            # 省略 enabled 时应保留原 enabled=True，而不是静默关掉
            r = c.put("/api/lan", json={"port": 8776},
                      headers={"Host": "127.0.0.1:8770", "Origin": "http://127.0.0.1:8770"})
            assert r.status_code == 200, r.text
            assert lan.cfg()["enabled"] is True and lan.cfg()["port"] == 8776
            assert m_apply.await_count == 1


def test_corrupt_ca_fallback_ifaces_and_extra_hosts_san():
    """损坏 ca.pem 不致 500 且可自动重签；缺 ip/ifconfig 回退纯 Python；EXTRA_HOSTS 合法项入 SAN，公网项不入 SAN。"""
    with _isolated_lan("mn-cert-"):
        lan._ensure_dir()
        lan.CA_PEM.write_bytes(b"NOT A CERT")
        lan.CA_KEY.write_bytes(b"NOT A KEY")
        assert lan.ca_info() is None, "损坏 ca.pem 应返回 None 而不是抛异常"

        with mock.patch.object(lan, "EXTRA_HOSTS", {"192.168.88.9", "custom.local", "box.tail.ts.net", "8.8.8.8", "evil.com"}):
            assert lan.ensure_certs() is True
        srv = x509.load_pem_x509_certificates(lan.SRV_PEM.read_bytes())[0]
        san = srv.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        san_ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
        san_dns = set(san.get_values_for_type(x509.DNSName))
        assert "192.168.88.9" in san_ips and "8.8.8.8" not in san_ips, san_ips
        assert {"custom.local", "box.tail.ts.net"} <= san_dns and "evil.com" not in san_dns, san_dns

        # 模拟极简容器既无 ip 也无 ifconfig：应走 _ifaces_fallback()
        with mock.patch.object(sys, "platform", "linux"), \
             mock.patch.object(lan.subprocess, "run", side_effect=FileNotFoundError("no ip/ifconfig")), \
             mock.patch.object(lan, "_ifaces_fallback", return_value=[("", "172.17.0.2", True)]) as m_fb:
            res = lan._ifaces()
        assert m_fb.called and res == [("", "172.17.0.2", True)], res


def test_lan_server_crash_cancels_watch():
    """LanServer._run 异常退出时应自动取消 watch 任务，避免后台任务泄漏。"""
    async def run():
        s = lan.LanServer()

        class CrashServer:
            async def serve(self, sockets):
                raise RuntimeError("boom")

        class DummySock:
            closed = False

            def close(self):
                self.closed = True

        cs = CrashServer()
        s.server = cs
        s.watch = asyncio.create_task(asyncio.sleep(60))
        sock = DummySock()
        await s._run(cs, sock)
        await asyncio.sleep(0)
        assert sock.closed
        assert s.watch is None
        assert "boom" in s.error

    asyncio.run(run())


def test_tailscale_platform_filtering():
    """_tailscale_names 只探测当前系统的候选路径并在首个存在的二进制后停止。"""
    with mock.patch.object(sys, "platform", "linux"):
        cands = lan._tailscale_candidates()
        assert cands == ("tailscale",), cands
    with mock.patch.object(sys, "platform", "darwin"):
        cands = lan._tailscale_candidates()
        assert all("Program Files" not in c for c in cands), cands


if __name__ == "__main__":
    try:
        for _name, _fn in list(globals().items()):
            if _name.startswith("test_") and callable(_fn):
                _fn()
                print("ok  ", _name)
        print("全部通过")
    finally:
        if _TMP is not None:
            shutil.rmtree(_TMP, ignore_errors=True)
