"""局域网访问的对抗测试：起一个独立的服务实例（临时数据、临时端口，开局域网访问），逐条模拟攻击，期望全部被拒；
同时做正向对照（正常用法必须还能用）。证书部分用 OpenSSL 独立验证名称限制。

用法：.venv/bin/python tests/test_lan_security.py      （约 1 分钟）
"""
import asyncio
import http.client
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
from datetime import UTC, datetime, timedelta
from ipaddress import ip_address
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_live_resume import Server, free_port  # noqa: E402

PW = "test-pass-1"
fails = 0


def check(ok, msg):
    global fails
    print(f"{'通过' if ok else '失败'}  {msg}")
    fails += not ok


def req(host, port, method, path, headers=None, body=None, tls=False):
    ctx = ssl._create_unverified_context() if tls else None
    c = http.client.HTTPSConnection(host, port, context=ctx, timeout=10) if tls else http.client.HTTPConnection(host, port, timeout=10)
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse()
    data = r.read()
    return r.status, dict(r.getheaders()), data


async def ws_try(url, origin=None, cookie=None, tls=False):
    hdr = {"Cookie": cookie} if cookie else {}
    try:
        async with websockets.connect(url, origin=origin, additional_headers=hdr, open_timeout=5,
                                      ssl=ssl._create_unverified_context() if tls else None) as ws:
            m = await asyncio.wait_for(ws.recv(), 5)
            return "accepted:" + str(m)[:40]
    except Exception as e:  # noqa: BLE001
        return "rejected:" + type(e).__name__


def lan_ip(data):
    """本机的 Wi-Fi / 有线 IP：用服务自己找地址的办法（lan.addresses），各系统通用。"""
    code = "import lan; print(next((a['ip'] for a in lan.addresses() if a['kind'] == 'lan'), ''))"
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parent.parent, capture_output=True,
                         text=True, env={**os.environ, "MEETING_DATA": str(data)}).stdout.strip()
    return out or None


def _connects(host, port) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def make_leaf(ca_key, ca, dns=(), ips=()):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(UTC)
    san = [x509.DNSName(d) for d in dns] + [x509.IPAddress(ip_address(i)) for i in ips]
    # CN 不写成主机名的样子：OpenSSL 会把像主机名的 CN 也拿去和名称限制比（iOS 只看 SAN），免得测混
    return (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "leaf test")]))
            .issuer_name(ca.subject).public_key(k.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=30))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, hashes.SHA256()))


async def main():
    tmp = Path(tempfile.mkdtemp(prefix="mn-sec-"))
    (tmp / "meetings").mkdir()
    srv = Server(tmp)
    lan_port = free_port()
    ip = lan_ip(tmp)
    try:
        srv.start()
        P = srv.port
        L = {"Host": f"127.0.0.1:{P}"}
        st, _, b = req("127.0.0.1", P, "PUT", "/api/lan", {**L, "Content-Type": "application/json"},
                       json.dumps({"enabled": True, "password": PW, "port": lan_port}))
        lan = json.loads(b)
        for _ in range(20):  # 机器慢时 HTTPS 端口要多等一会儿才起来
            if lan.get("running") or lan.get("error"):
                break
            time.sleep(0.5)
            lan = json.loads(req("127.0.0.1", P, "GET", "/api/lan", L)[2])
        check(st == 200 and lan["running"], f"正向：本机开启局域网访问（端口 {lan_port}）{lan.get('error') or ''}")

        print("\n-- DNS rebinding（伪造 Host）--")
        st, _, _ = req("127.0.0.1", P, "GET", "/api/meetings", {"Host": f"evil.test:{P}"})
        check(st == 421, f"Host=evil.test 读会议列表 → {st}（应 421）")
        st, _, _ = req("127.0.0.1", P, "PUT", "/api/lan", {"Host": f"evil.test:{P}", "Origin": f"http://evil.test:{P}",
                                                          "Content-Type": "application/json"}, json.dumps({"enabled": True, "password": "attacker-pw"}))
        check(st == 421, f"Host=evil.test 改局域网口令 → {st}（应 421）")
        for h in (f"127.0.0.1:{P}", f"localhost:{P}", f"[::1]:{P}"):
            st, _, _ = req("127.0.0.1", P, "GET", "/api/meetings", {"Host": h})
            check(st == 200, f"正向：Host={h} → {st}")

        print("\n-- 跨站请求 --")
        st, _, _ = req("127.0.0.1", P, "POST", "/api/asr/reload", {**L, "Origin": "https://evil.test", "Content-Type": "text/plain"})
        check(st == 403, f"跨站简单请求（text/plain，不触发预检）POST /api/asr/reload → {st}（应 403）")
        st, _, _ = req("127.0.0.1", P, "POST", "/api/asr/reload", {**L, "Origin": "null"})
        check(st == 403, f"Origin: null（沙箱 iframe）→ {st}（应 403）")
        st, _, _ = req("127.0.0.1", P, "POST", "/api/asr/reload", {**L, "Origin": f"http://127.0.0.1:{P}"})
        check(st == 200, f"正向：同源 POST → {st}")
        st, _, _ = req("127.0.0.1", P, "POST", "/api/asr/reload", L)
        check(st == 200, f"正向：不带 Origin（curl、脚本）→ {st}")
        st, _, _ = req("127.0.0.1", P, "GET", "/api/meetings", {**L, "Origin": "https://evil.test"})
        check(st == 200, f"跨站 GET 不拦（浏览器同源策略本身不让对方读到响应）→ {st}")

        print("\n-- 跨站 WebSocket --")
        r = await ws_try(f"ws://127.0.0.1:{P}/ws/ambient", origin="https://evil.test")
        check(r.startswith("rejected"), f"Origin=evil.test 连 /ws/ambient → {r}")
        r = await ws_try(f"ws://127.0.0.1:{P}/ws/ambient", origin=f"http://127.0.0.1:{P}")
        check(r.startswith("accepted"), f"正向：同源连 /ws/ambient → {r[:20]}")

        if ip and lan["running"]:
            print(f"\n-- 局域网端口（https://{ip}:{lan_port}）--")
            T = {"Host": f"{ip}:{lan_port}"}
            st, _, _ = req(ip, lan_port, "GET", "/api/meetings", T, tls=True)
            check(st == 401, f"没登录读会议 → {st}（应 401）")
            st, _, _ = req(ip, lan_port, "GET", "/api/meetings", {"Host": f"evil.test:{lan_port}"}, tls=True)
            check(st == 421, f"局域网端口 Host=evil.test → {st}（应 421）")
            r = await ws_try(f"wss://{ip}:{lan_port}/ws/ambient", origin=f"https://{ip}:{lan_port}", tls=True)
            check(r.startswith("rejected"), f"没登录连 WebSocket → {r}")
            body = urllib.parse.urlencode({"password": PW, "next": "/"})
            st, hd, _ = req(ip, lan_port, "POST", "/lan/login", {**T, "Origin": f"https://{ip}:{lan_port}",
                                                                "Content-Type": "application/x-www-form-urlencoded"}, body, tls=True)
            cookie = (hd.get("set-cookie") or hd.get("Set-Cookie") or "").split(";")[0]
            check(st == 303 and cookie.startswith("mn_lan="), f"正向：口令登录 → {st}")
            st, _, _ = req(ip, lan_port, "POST", "/lan/login", {**T, "Origin": "https://evil.test", "Content-Type": "application/x-www-form-urlencoded"},
                           body, tls=True)
            check(st == 403, f"跨站页面代填口令登录（登录 CSRF）→ {st}（应 403）")
            st, hd, _ = req(ip, lan_port, "GET", "/api/meetings", {**T, "Cookie": cookie}, tls=True)
            cc = hd.get("cache-control") or hd.get("Cache-Control")
            check(st == 200 and cc == "no-store", f"登录后读会议 → {st}，Cache-Control: {cc}（应 no-store）")
            st, hd, _ = req("127.0.0.1", P, "GET", "/api/meetings", L)
            check("no-store" not in str(hd.get("cache-control", "")), "正向：本机访问不加 no-store（不影响本机缓存）")
            r = await ws_try(f"wss://{ip}:{lan_port}/ws/ambient", origin="https://evil.test", cookie=cookie, tls=True)
            check(r.startswith("rejected"), f"带着登录 Cookie、但从跨站页面连 WebSocket → {r}")
            r = await ws_try(f"wss://{ip}:{lan_port}/ws/ambient", origin=f"https://{ip}:{lan_port}", cookie=cookie, tls=True)
            check(r.startswith("accepted"), f"正向：登录后同源连 WebSocket → {r[:20]}")
            codes = []
            for _ in range(6):
                st, _, _ = req(ip, lan_port, "POST", "/lan/login", {**T, "Content-Type": "application/x-www-form-urlencoded"},
                               urllib.parse.urlencode({"password": "wrong", "next": "/"}), tls=True)
                codes.append(st)
            check(codes == [401] * 5 + [429], f"同一 IP 连续输错 → {codes}（输错 5 次后锁定，第 6 次 429）")
            if shutil.which("nmap"):
                out = subprocess.run(["nmap", "-Pn", "-p", f"{P},{lan_port}", ip], capture_output=True, text=True).stdout
                opened = [line.split("/")[0] for line in out.splitlines() if "/tcp" in line and " open " in line]
            else:  # 没装 nmap（CI）：直接连一下
                opened = [str(p) for p in (P, lan_port) if _connects(ip, p)]
            check(opened == [str(lan_port)], f"扫本机局域网 IP：开放端口 {opened}（应只有 {lan_port}，本机端口 {P} 不对外）")
        else:
            check(False, "没取到局域网 IP（或局域网服务没起来），局域网部分没测")

        print("\n-- 证书（OpenSSL 独立验证）--")
        from cryptography import x509
        from cryptography.hazmat.primitives import serialization
        d = tmp / "lan"
        ca = x509.load_pem_x509_certificate((d / "ca.pem").read_bytes())
        ca_key = serialization.load_pem_private_key((d / "ca.key").read_bytes(), None)
        nc = ca.extensions.get_extension_for_class(x509.NameConstraints)
        check(nc.critical and nc.value.permitted_subtrees, f"根证书带名称限制（critical）：{[str(getattr(g, 'value', g)) for g in nc.value.permitted_subtrees]}")
        srv_cert = x509.load_pem_x509_certificates((d / "server.pem").read_bytes())[0]
        san = srv_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        names = [str(v) for v in san.get_values_for_type(x509.DNSName)] + [str(v) for v in san.get_values_for_type(x509.IPAddress)]
        check("localhost" not in names and "127.0.0.1" not in names, f"服务器证书只含允许的名字：{names}")
        cases = [("服务器证书本身", None, True), ("192.168.1.20", make_leaf(ca_key, ca, ips=["192.168.1.20"]), True),
                 ("xxx.local", make_leaf(ca_key, ca, dns=["xxx.local"]), True), ("mac.tail1234.ts.net", make_leaf(ca_key, ca, dns=["mac.tail1234.ts.net"]), True),
                 ("www.apple.com（偷到私钥冒充公网网站）", make_leaf(ca_key, ca, dns=["www.apple.com"]), False),
                 ("8.8.8.8", make_leaf(ca_key, ca, ips=["8.8.8.8"]), False), ("127.0.0.1", make_leaf(ca_key, ca, ips=["127.0.0.1"]), False),
                 ("evil.local.example.com", make_leaf(ca_key, ca, dns=["evil.local.example.com"]), False)]
        for name, leaf, want in cases:
            p = d / "leaf-test.pem"
            p.write_bytes((d / "server.pem").read_bytes() if leaf is None else leaf.public_bytes(serialization.Encoding.PEM))
            out = subprocess.run(["openssl", "verify", "-CAfile", str(d / "ca.pem"), "-purpose", "sslserver", str(p)], capture_output=True, text=True)
            ok = out.returncode == 0
            lines = (out.stdout + out.stderr).strip().splitlines()
            why = next((x.split(": ", 1)[-1] for x in lines if "error" in x and "lookup" in x), lines[-1] if lines else "") if not ok else "OK"
            check(ok == want, f"openssl verify {name} → {'接受' if ok else '拒绝'}（{why[:70]}）")

        print("\n-- 全局登录限速（换着 IP 猜）--")
        code = ("import lan; [lan._failed(f'10.0.0.{i}') for i in range(20)]; print(lan._locked('10.9.9.9'))")
        out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parent.parent, capture_output=True, text=True,
                             env={**os.environ, "MEETING_DATA": str(tmp)}).stdout.strip()
        check(out.isdigit() and int(out) > 500, f"20 个不同 IP 各错 1 次后，第 21 个新 IP 也被暂停登录 {out} 秒")
    finally:
        srv.stop()
    if fails and os.environ.get("CI"):  # CI 上看不到临时目录，把服务日志打出来
        print((tmp / "server.log").read_text("utf-8", "replace")[-4000:])
    print(f"\n{'全部通过' if not fails else f'{fails} 项失败'}（日志：{tmp / 'server.log'}）")
    if not fails:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(1 if fails else 0)
