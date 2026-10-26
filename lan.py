"""局域网访问（默认关闭）：同一 Wi-Fi 下的平板、手机用浏览器打开会议记录。

- 另开一个 HTTPS 端口（默认 8771）对局域网开放；原来的 127.0.0.1:8770 不变，本机访问不需要口令。
- 不是从本机来的请求都要先用访问口令登录（Cookie，30 天）；口令只存 PBKDF2 哈希。改口令、
  “让所有设备退出”后旧的登录全部失效；连续输错会锁一段时间。
- 证书：第一次开启时在 data/lan/ 生成这台 Mac 专用的根证书（5 年）和服务器证书（800 天，含本机局域网 IP 和 xxx.local）。
  根证书带“名称限制”（Name Constraints）：只能给私网 IP（10/8、172.16/12、192.168/16、Tailscale 100.64/10）
  和 .local / .ts.net 签证书。手机信任它以后，就算 data/lan/ca.key 被人拿走，也冒充不了任何公网网站。
  IP 变了自动重签服务器证书，根证书不变、不用重装。
- 防 DNS rebinding：所有请求的 Host 必须是本机的地址（127.0.0.1、localhost、本机 IP、xxx.local、Tailscale 名字）；
  改数据的请求和 WebSocket 的 Origin 必须和 Host 一致（跨站网页发不进来）。
- 局域网设备拿到的接口响应都带 Cache-Control: no-store，会议内容不留在手机浏览器缓存里。
- 局域网服务和主服务共用同一个 app、同一个事件循环，不单独起进程。
"""
import asyncio
import contextlib
import errno
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import subprocess
import time
from datetime import UTC, datetime, timedelta
from html import escape
from urllib.parse import quote, urlsplit

import uvicorn
from fastapi import APIRouter, Body, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response

import store

log = logging.getLogger("lan")
DIR = store.DATA / "lan"
CFG = DIR / "config.json"
CA_KEY, CA_PEM, SRV_KEY, SRV_PEM = (DIR / n for n in ("ca.key", "ca.pem", "server.key", "server.pem"))
DEFAULTS = {"enabled": False, "port": 8771, "pw_salt": "", "pw_hash": "", "secret": ""}
COOKIE = "mn_lan"
MAX_AGE = 30 * 86400
MAIN_PORT = int(os.environ.get("PORT") or 8770)
PUBLIC = {"/lan/login", "/lan/logout", "/lan/ca.cer", "/lan/icon.png"}  # 没登录也能打开：登录页、下载根证书

_cfg: dict | None = None


def cfg() -> dict:
    global _cfg
    if _cfg is None:
        _cfg = {**DEFAULTS, **(store.read_json(CFG) or {})}
    return _cfg


def _save(**kw) -> dict:
    global _cfg
    c = {**cfg(), **kw}
    DIR.mkdir(parents=True, exist_ok=True)
    store.write_json(CFG, c)
    os.chmod(CFG, 0o600)
    _cfg = c
    return c


# ---------------- 口令和登录 ----------------
def _pbkdf(pw: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()


def set_password(pw: str) -> None:
    salt = secrets.token_hex(16)
    _save(pw_salt=salt, pw_hash=_pbkdf(pw, salt), secret=secrets.token_hex(32))  # 换口令 = 旧登录全部失效


def check_password(pw: str) -> bool:
    c = cfg()
    return bool(c["pw_hash"]) and hmac.compare_digest(_pbkdf(pw, c["pw_salt"]), c["pw_hash"])


def logout_all() -> None:
    _save(secret=secrets.token_hex(32))


def _sign(ts: str) -> str:
    return hmac.new(bytes.fromhex(cfg()["secret"]), ts.encode(), "sha256").hexdigest()


def make_token() -> str:
    ts = str(int(time.time()))
    return f"{ts}.{_sign(ts)}"


def valid_token(tok: str | None) -> bool:
    if not tok or "." not in tok or not cfg()["secret"]:
        return False
    ts, sig = tok.split(".", 1)
    return ts.isdigit() and time.time() - int(ts) < MAX_AGE and hmac.compare_digest(sig, _sign(ts))


_fails: dict[str, list] = {}  # ip -> [连续输错次数, 锁到什么时候]
# 换着 IP 猜（IPv6 临时地址、多台设备）：所有来源合计 10 分钟内错 20 次，全部暂停登录 10 分钟
_all_fails: list[float] = []
_all_lock = [0.0]
GLOBAL_FAILS, GLOBAL_WINDOW, GLOBAL_LOCK = 20, 600, 600


def _locked(ip: str) -> int:
    f = _fails.get(ip)
    return max(0, int(max(f[1] if f else 0, _all_lock[0]) - time.time()))


def _failed(ip: str) -> None:
    f = _fails.setdefault(ip, [0, 0.0])
    f[0] += 1
    if f[0] >= 5:  # 第 5 次起每次多锁一倍：30 秒、1 分钟、2 分钟……最多 1 小时
        f[1] = time.time() + min(3600, 30 * 2 ** (f[0] - 5))
    now = time.time()
    _all_fails[:] = [t for t in _all_fails if now - t < GLOBAL_WINDOW] + [now]
    if len(_all_fails) >= GLOBAL_FAILS:
        _all_lock[0] = now + GLOBAL_LOCK
        _all_fails.clear()
        log.warning("LAN login: %d failures in %ds from all sources, locking logins for %ds", GLOBAL_FAILS, GLOBAL_WINDOW, GLOBAL_LOCK)


def is_local(scope) -> bool:
    c = scope.get("client")
    try:
        ip = ipaddress.ip_address(c[0])
    except (TypeError, ValueError, IndexError):
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback


_hosts = [0.0, set()]  # [上次刷新时间, 允许的 Host]
EXTRA_HOSTS = {h.strip().lower() for h in (os.environ.get("MN_ALLOWED_HOSTS") or "").split(",") if h.strip()}


def _tailscale_names() -> set[str]:
    for exe in ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        try:
            out = subprocess.run([exe, "status", "--json"], capture_output=True, text=True, timeout=2, check=False).stdout
            name = (json.loads(out).get("Self") or {}).get("DNSName", "").rstrip(".").lower()
            return {name} if name else set()
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
    return set()


def allowed_hosts(refresh: bool = False) -> set[str]:
    """能用来打开会议记录的主机名：本机回环、本机各网卡 IP、xxx.local、Tailscale 名字，以及 MN_ALLOWED_HOSTS 里加的。"""
    if refresh or time.time() - _hosts[0] > 60:
        _hosts[1] = ({"127.0.0.1", "localhost", "::1"} | {a["ip"] for a in addresses()} | {hostname().lower()}
                     | _tailscale_names() | EXTRA_HOSTS)
        _hosts[0] = time.time()
    return _hosts[1]


def _header(scope, name: bytes) -> str | None:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return None


def host_name(host: str) -> str:
    h = host.strip().lower()
    if h.startswith("["):
        return h[1:h.find("]")] if "]" in h else h
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


def host_ok(scope) -> bool:
    """防 DNS rebinding：恶意网页把自己的域名临时解析到 127.0.0.1 时，浏览器发来的 Host 还是那个域名。"""
    h = host_name(_header(scope, b"host") or "")
    if not h:
        return False
    if h in allowed_hosts():
        return True
    if time.time() - _hosts[0] > 5:  # 刚换了网络 / IP：马上重新取一次再判断
        return h in allowed_hosts(refresh=True)
    return False


UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def origin_ok(scope) -> bool:
    """改数据的请求和 WebSocket：浏览器带的 Origin 必须就是这个网站本身（同一个 Host）。没有 Origin 的不是浏览器发的，放行。"""
    if scope["type"] == "http" and scope.get("method") not in UNSAFE:
        return True
    origin = _header(scope, b"origin")
    if origin is None:
        return True
    host = (_header(scope, b"host") or "").lower()
    return origin != "null" and urlsplit(origin).netloc.lower() == host


def _cookie(scope) -> str | None:
    for k, v in scope.get("headers", []):
        if k == b"cookie":
            for part in v.decode("latin-1").split(";"):
                name, _, val = part.strip().partition("=")
                if name == COOKIE:
                    return val
    return None


class Guard:
    """所有请求先过这里：
    1. Host 不是本机地址（DNS rebinding）→ 拒绝；
    2. 改数据的请求 / WebSocket 的 Origin 不是本站（跨站请求、跨站 WebSocket）→ 拒绝；
    3. 不是从本机来的（局域网里的平板、手机）：没登录时网页跳到登录页，接口返回 401，WebSocket 直接拒绝；
       登录了的，接口响应加 Cache-Control: no-store。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        if not host_ok(scope):
            log.warning("rejected Host %r for %s", _header(scope, b"host"), scope["path"])
            return await self._deny(scope, receive, send, 421, "这个地址不能用来打开会议记录（Host 不是这台 Mac 的地址）")
        if not origin_ok(scope):
            log.warning("rejected Origin %r for %s %s", _header(scope, b"origin"), scope.get("method", "WS"), scope["path"])
            return await self._deny(scope, receive, send, 403, "跨站请求被拒绝")
        local = is_local(scope)
        if local or scope["path"] in PUBLIC or valid_token(_cookie(scope)):
            if local or scope["type"] != "http" or not scope["path"].startswith("/api/"):
                return await self.app(scope, receive, send)

            async def no_store(msg):  # 会议内容不留在手机浏览器的缓存里
                if msg["type"] == "http.response.start":
                    msg = {**msg, "headers": [(k, v) for k, v in msg.get("headers", []) if k.lower() != b"cache-control"]
                           + [(b"cache-control", b"no-store")]}
                await send(msg)
            return await self.app(scope, receive, no_store)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        path = scope["path"]
        if path.startswith(("/api/", "/static/")):
            resp = Response('{"detail":"需要先登录（输入访问口令）","login":"/lan/login"}', 401, media_type="application/json")
        else:
            resp = RedirectResponse("/lan/login?next=" + quote(path), 303)
        await resp(scope, receive, send)

    @staticmethod
    async def _deny(scope, receive, send, code: int, msg: str):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await Response(json.dumps({"detail": msg}, ensure_ascii=False), code, media_type="application/json")(scope, receive, send)


# ---------------- 地址和证书 ----------------
def hostname() -> str:
    try:
        n = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        n = ""
    return (n or socket.gethostname().split(".")[0]) + ".local"


def addresses() -> list[dict]:
    """本机的 IPv4 地址。Wi-Fi / 有线（有广播地址的网卡）排前面，其次 Tailscale（100.64/10）；
    代理软件的虚拟网卡（198.18/15 之类）手机连不上，只放进证书、不列出来。"""
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    res, iface = [], ""
    for line in out.splitlines():
        m = re.match(r"^(\S+): flags", line)
        if m:
            iface = m.group(1)
            continue
        m = re.match(r"\s+inet (\d+\.\d+\.\d+\.\d+)", line)
        if not m:
            continue
        ip = ipaddress.ip_address(m.group(1))
        if ip.is_loopback or ip.is_link_local:
            continue
        kind = ("lan" if "broadcast" in line and not iface.startswith(("utun", "lo")) and ip.is_private
                else "tailscale" if ip in ipaddress.ip_network("100.64.0.0/10") else "other")
        res.append({"ip": str(ip), "iface": iface, "kind": kind})
    order = {"lan": 0, "tailscale": 1, "other": 2}
    return sorted(res, key=lambda a: (order[a["kind"]], not a["iface"].startswith("en"), a["iface"]))


def _x509():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    return x509, hashes, serialization, rsa, ExtendedKeyUsageOID, NameOID


def _write_key(path, key, serialization) -> None:
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    os.chmod(path, 0o600)


# 根证书只能签这些名字（RFC 5280 Name Constraints）：私网 IPv4、Tailscale、.local、.ts.net
PERMITTED_NETS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")]
PERMITTED_DNS = ["local", "ts.net"]


def _permitted_ip(ip: str) -> bool:
    a = ipaddress.ip_address(ip)
    return any(a in n for n in PERMITTED_NETS)


def _permitted_dns(name: str) -> bool:
    return any(name == d or name.endswith("." + d) for d in PERMITTED_DNS)


def _load_ca():
    x509, hashes, serialization, rsa, _, NameOID = _x509()
    if CA_KEY.exists() and CA_PEM.exists():
        key, cert = serialization.load_pem_private_key(CA_KEY.read_bytes(), None), x509.load_pem_x509_certificate(CA_PEM.read_bytes())
        try:
            cert.extensions.get_extension_for_class(x509.NameConstraints)
            return key, cert
        except x509.ExtensionNotFound:
            # 旧版根证书没有名称限制：作废（删掉私钥），换一张有限制的。装过旧证书的设备要重新安装
            log.warning("replacing LAN root CA without name constraints")
            CA_PEM.replace(DIR / "ca-old-unconstrained.pem")
            CA_KEY.unlink()
            _save(ca_replaced=int(time.time()))
    DIR.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"会议记录 本机根证书（{hostname().removesuffix('.local')}）"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "meeting-notes")])
    now = datetime.now(UTC)
    ku = x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False,
                       key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=5 * 365))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(ku, critical=True)
            .add_extension(x509.NameConstraints(permitted_subtrees=[x509.DNSName(d) for d in PERMITTED_DNS] + [x509.IPAddress(n) for n in PERMITTED_NETS],
                                                excluded_subtrees=None), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    _write_key(CA_KEY, key, serialization)
    CA_PEM.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    SRV_PEM.unlink(missing_ok=True)
    log.info("created local root CA")
    return key, cert


def ensure_certs() -> bool:
    """证书不存在、快过期、或者本机 IP / 名字不在证书里时重签服务器证书。返回是否重签了。"""
    x509, hashes, serialization, rsa, EKU, NameOID = _x509()
    ca_key, ca = _load_ca()
    host = hostname()
    # 只放根证书允许的名字（名称限制之外的名字会让整张证书失效）：局域网 / Tailscale IP、xxx.local、Tailscale 名字
    ips = {a["ip"] for a in addresses() if _permitted_ip(a["ip"])}
    dns = {n for n in {host.lower(), *_tailscale_names()} if _permitted_dns(n)}
    now = datetime.now(UTC)
    if SRV_PEM.exists() and SRV_KEY.exists():
        try:
            cur = x509.load_pem_x509_certificates(SRV_PEM.read_bytes())[0]
            san = cur.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            have_ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
            have_dns = set(san.get_values_for_type(x509.DNSName))
            issuer_ok = cur.issuer == ca.subject and cur.verify_directly_issued_by(ca) is None
            if issuer_ok and ips <= have_ips and dns <= have_dns and cur.not_valid_after_utc - now > timedelta(days=30) \
                    and all(_permitted_ip(i) for i in have_ips) and all(_permitted_dns(n) for n in have_dns):
                return False
            ips |= {i for i in have_ips if _permitted_ip(i)}  # 换过网络的旧地址也留着，切回来时不用再重签
        except Exception:  # 旧证书读不了就重签
            log.warning("bad LAN certificate, reissuing", exc_info=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ku = x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True, data_encipherment=False,
                       key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False)
    san = [x509.DNSName(d) for d in sorted(dns)] + [x509.IPAddress(ipaddress.ip_address(i)) for i in sorted(ips)]
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=800))  # 苹果要求不超过 825 天
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(ku, critical=True)
            .add_extension(x509.ExtendedKeyUsage([EKU.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    _write_key(SRV_KEY, key, serialization)
    SRV_PEM.write_bytes(cert.public_bytes(serialization.Encoding.PEM) + ca.public_bytes(serialization.Encoding.PEM))
    log.info("issued LAN server certificate for %s %s", sorted(dns), sorted(ips))
    return True


def ca_info() -> dict | None:
    if not CA_PEM.exists():
        return None
    x509, hashes, serialization, *_ = _x509()
    ca = x509.load_pem_x509_certificate(CA_PEM.read_bytes())
    fp = ca.fingerprint(hashes.SHA256()).hex().upper()
    return {"der": ca.public_bytes(serialization.Encoding.DER), "sha256": ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)),
            "name": ca.subject.rfc4514_string()}


def firewall_on() -> bool:
    try:
        out = subprocess.run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"],
                             capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "enabled" in out.lower()


# ---------------- 局域网 HTTPS 服务 ----------------
def _listening(port: int) -> bool:
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            pass
    return False


class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self):  # 信号交给主服务处理：Ctrl+C 时主服务关闭、顺带关掉这里
        yield


class LanServer:
    def __init__(self):
        self.app = None
        self.server: _Server | None = None
        self.task: asyncio.Task | None = None
        self.watch: asyncio.Task | None = None
        self.ssl = None
        self.port = 0
        self.error = ""
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return bool(self.server and self.server.started and self.task and not self.task.done())

    async def apply(self) -> None:
        """按配置启动 / 重启 / 停止。"""
        async with self._lock:
            await self._stop()
            c = cfg()
            self.error = ""
            if not c["enabled"]:
                return
            if not c["pw_hash"]:
                self.error = "还没有设置访问口令"
                return
            try:
                await asyncio.to_thread(ensure_certs)
            except Exception as e:
                log.exception("cert")
                self.error = f"生成证书失败：{e}"
                return
            port = int(c["port"])
            # macOS 上设了 SO_REUSEADDR 时，别的程序占着 0.0.0.0:端口 也能绑定成功，手机却会连到那个程序：先试着连一下
            if await asyncio.to_thread(_listening, port):
                self.error = f"端口 {port} 已被别的程序占用，换一个端口再试"
                return
            sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)  # 同时收 IPv4（xxx.local 可能先解析出 IPv6）
                sock.bind(("::", port))
                sock.listen(128)
                sock.setblocking(False)
            except OSError as e:
                sock.close()
                self.error = (f"端口 {port} 已被别的程序占用，换一个端口再试" if e.errno == errno.EADDRINUSE else f"无法监听端口 {port}：{e}")
                return
            config = uvicorn.Config(self.app, lifespan="off", log_config=None, proxy_headers=False, log_level="warning",
                                    ssl_certfile=str(SRV_PEM), ssl_keyfile=str(SRV_KEY), timeout_graceful_shutdown=3)
            try:
                config.load()
            except (Exception, SystemExit) as e:  # noqa: BLE001 —— uvicorn 出错时会 sys.exit，不能让它带走主服务
                sock.close()
                self.error = f"启动失败：{e}"
                return
            self.ssl, self.port = config.ssl, port
            self.server = _Server(config)
            self.task = asyncio.create_task(self._run(self.server, sock))
            self.watch = asyncio.create_task(self._watch_ip())
            for _ in range(50):
                if self.server.started or self.task.done():
                    break
                await asyncio.sleep(0.05)
            log.info("LAN access on https://[::]:%d (%s)", port, "ok" if self.running else self.error)

    async def _run(self, server: _Server, sock: socket.socket) -> None:
        try:
            await server.serve(sockets=[sock])
        except (Exception, SystemExit) as e:
            log.exception("LAN server crashed")
            self.error = f"局域网服务出错：{e}"
        finally:
            sock.close()

    async def _watch_ip(self) -> None:
        """每分钟看一下 IP 有没有变：变了就重签服务器证书，新连接直接用新证书，不用重启。"""
        while True:
            await asyncio.sleep(60)
            try:
                if await asyncio.to_thread(ensure_certs) and self.ssl:
                    self.ssl.load_cert_chain(str(SRV_PEM), str(SRV_KEY))
            except Exception:
                log.exception("refresh cert")

    async def _stop(self) -> None:
        if self.watch:
            self.watch.cancel()
            self.watch = None
        if self.server and self.task:
            self.server.should_exit = True
            try:
                await asyncio.wait_for(asyncio.shield(self.task), 6)
            except TimeoutError:
                self.server.force_exit = True
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.task, 3)
        self.server = self.task = self.ssl = None

    async def stop(self) -> None:
        async with self._lock:
            await self._stop()


server = LanServer()


# ---------------- 接口 ----------------
router = APIRouter()


def _client_local(request: Request) -> bool:
    return is_local(request.scope)


def _only_here(request: Request) -> None:
    if not _client_local(request):
        raise HTTPException(403, "局域网访问的设置只能在这台 Mac 上修改")


def status(request: Request | None = None) -> dict:
    c = cfg()
    port = int(c["port"])
    urls = []
    if server.running:
        for a in addresses():
            if a["kind"] == "other":
                continue
            urls.append({"url": f"https://{a['ip']}:{port}", "label": "Wi-Fi / 有线" if a["kind"] == "lan" else "Tailscale"})
        urls.append({"url": f"https://{hostname()}:{port}", "label": "用名字访问（iPhone、iPad、Mac 可用，IP 变了也不用换）"})
        import segno
        for u in urls:
            u["qr"] = segno.make(u["url"], error="m").svg_inline(scale=1, border=2, dark="#171717", omitsize=True)
    ca = ca_info()
    return {"enabled": c["enabled"], "port": port, "has_password": bool(c["pw_hash"]), "running": server.running,
            "error": server.error, "urls": urls, "ca_sha256": ca and ca["sha256"], "ca_replaced": c.get("ca_replaced") if time.time() - (c.get("ca_replaced") or 0) < 30 * 86400 else None, "firewall": firewall_on() if c["enabled"] else False,
            "local": _client_local(request) if request else True}


@router.get("/api/lan")
def get_lan(request: Request):
    return status(request)


@router.put("/api/lan")
async def put_lan(request: Request, body: dict = Body(...)):
    _only_here(request)
    c = cfg()
    pw = (body.get("password") or "").strip()
    if pw:
        if len(pw) < 6:
            raise HTTPException(400, "访问口令至少 6 位")
        set_password(pw)
    port = int(body.get("port") or c["port"])
    if not 1024 <= port <= 65535 or port == MAIN_PORT:
        raise HTTPException(400, f"端口要在 1024–65535 之间，且不能和本机端口 {MAIN_PORT} 相同")
    enabled = bool(body.get("enabled"))
    if enabled and not cfg()["pw_hash"]:
        raise HTTPException(400, "开启前请先设置访问口令（至少 6 位）")
    changed = pw or enabled != c["enabled"] or port != int(c["port"]) or (enabled and not server.running)
    _save(enabled=enabled, port=port)
    if changed:
        await server.apply()
    return status(request)


@router.post("/api/lan/logout-all")
def lan_logout_all(request: Request):
    _only_here(request)
    logout_all()
    return status(request)


@router.get("/lan/ca.cer")
def ca_cert():
    ca = ca_info()
    if not ca:
        raise HTTPException(404, "还没有生成证书：先在 Mac 上的“设置 · 平板、手机访问”里开启")
    return Response(ca["der"], media_type="application/x-x509-ca-cert",
                    headers={"Content-Disposition": 'attachment; filename="meeting-notes-ca.cer"'})


@router.get("/lan/icon.png")
def icon():  # 添加到主屏幕时的图标；登录前也要能拿到
    return FileResponse(store.BASE / "static" / "icon.png", media_type="image/png", headers={"Cache-Control": "max-age=86400"})


def _next(v: str) -> str:
    return v if v.startswith("/") and not v.startswith("//") and "\\" not in v else "/"


@router.get("/lan/login")
def login_page(request: Request, next: str = "/", err: str = ""):
    if is_local(request.scope) or valid_token(request.cookies.get(COOKIE)):
        return RedirectResponse(_next(next), 303)
    return HTMLResponse(_login_html(_next(next), err), headers={"Cache-Control": "no-store"})


@router.post("/lan/login")
def login(request: Request, password: str = Form(""), next: str = Form("/")):
    ip = request.client.host if request.client else "?"
    wait = _locked(ip)
    if wait:
        return HTMLResponse(_login_html(_next(next), f"输错次数太多，请 {wait} 秒后再试"), 429)
    if not check_password(password):
        _failed(ip)
        log.warning("LAN login failed from %s", ip)
        return HTMLResponse(_login_html(_next(next), "口令不对" if not _locked(ip) else f"输错次数太多，请 {_locked(ip)} 秒后再试"), 401)
    _fails.pop(ip, None)
    log.info("LAN login from %s", ip)
    resp = RedirectResponse(_next(next), 303)
    resp.set_cookie(COOKIE, make_token(), max_age=MAX_AGE, httponly=True, secure=True, samesite="lax")
    return resp


@router.get("/lan/logout")
def logout():
    resp = RedirectResponse("/lan/login", 303)
    resp.delete_cookie(COOKIE)
    return resp


def _login_html(nxt: str, err: str) -> str:
    ca = ca_info()
    fp = ca["sha256"][:47] + "…" if ca else ""
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#f5f5f5">
<title>登录 · 会议记录</title><link rel="apple-touch-icon" href="/lan/icon.png">
<style>
*{{box-sizing:border-box}} body{{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#171717;
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;
padding:24px max(16px,env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}}
.card{{width:min(420px,100%);background:#fff;border-radius:16px;box-shadow:0 0 0 1px rgba(0,0,0,.055),0 10px 28px -10px rgba(0,0,0,.16);padding:28px 24px}}
.brand{{display:flex;align-items:center;gap:10px;margin-bottom:18px}} .logo{{width:36px;height:36px;border-radius:10px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center}}
.logo svg{{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}}
h1{{font-size:18px;margin:0;font-weight:600}} p{{margin:0 0 14px;color:#525252;font-size:14px}}
input{{width:100%;font:inherit;font-size:16px;height:46px;padding:0 14px;border:1px solid transparent;border-radius:10px;background:rgba(0,0,0,.05);outline:none}}
input:focus{{background:#fff;border-color:rgba(0,0,0,.2);box-shadow:0 0 0 3px rgba(0,0,0,.06)}}
button{{width:100%;height:46px;margin-top:12px;border:none;border-radius:10px;background:#171717;color:#fff;font:inherit;font-size:16px;font-weight:500}}
button:active{{transform:scale(.98)}} .err{{color:#ce2c31;font-size:14px;margin-top:10px;min-height:1em}} .small{{font-size:13px;color:#646464}}
.inapp{{display:none;margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#fffaf0;color:#92400e;box-shadow:0 0 0 1px rgba(217,119,6,.25);font-size:13.5px}}
details{{margin-top:18px;border-top:1px solid rgba(0,0,0,.06);padding-top:14px;font-size:13.5px;color:#525252}} summary{{cursor:pointer;color:#171717}}
ol{{padding-left:20px;margin:8px 0}} li{{margin:4px 0}} a.btn{{display:inline-block;margin:6px 0;padding:6px 12px;border-radius:8px;background:rgba(0,0,0,.05);color:#171717;text-decoration:none}}
code{{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all;color:#646464}}
</style></head><body><form class="card" method="post" action="/lan/login">
<div class="brand"><span class="logo"><svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/></svg></span><h1>会议记录</h1></div>
<div class="inapp" id="inapp"></div>
<p>这是 Mac 上的会议记录服务。输入在 Mac 上“设置 · 平板、手机访问”里设好的访问口令。</p>
<input type="password" name="password" placeholder="访问口令" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="{escape(nxt)}"><button>登录</button>
<div class="err">{escape(err)}</div><div class="small">登录后这台设备 30 天内不用再输。</div>
<details><summary>浏览器提示“不安全”，或者 iPhone / iPad 上录不了音？</summary>
<p style="margin-top:8px">这是 Mac 自己签发的证书。装上并信任它以后浏览器不再提示。<b>建议在 iPhone / iPad 上装好</b>：不装的话每次都会提示“不安全”，部分 iOS 版本上录音（实时转写连接）会连不上。</p>
{'<a class="btn" href="/lan/ca.cer">下载证书</a>' if ca else '<span class="small">（还没有生成证书）</span>'}
<ol><li><b>iPhone / iPad</b>：用 Safari 点“下载证书”并允许下载，到“设置 → 已下载的描述文件”安装；再到“设置 → 通用 → 关于本机 → 证书信任设置”，打开“会议记录 本机根证书”的开关。</li>
<li><b>安卓</b>：点“下载证书”，到“设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书”选择刚下载的文件（不同品牌的菜单名称略有不同）。</li></ol>
{f'<div class="small">证书指纹（可以和 Mac 设置页里显示的对一下）：<br><code>{fp}</code></div>' if ca else ''}
</details></form>
<script>/* 网址里 # 后面的部分（要打开的那场会议）服务器看不到：带到表单地址上，输错一次、登录跳转后都还在 */
document.forms[0].action = "/lan/login" + location.hash;
/* 微信、飞书等应用里扫码打开：证书、录音都可能不正常，先提示换浏览器 */
var m = navigator.userAgent.match(/MicroMessenger|Lark|Feishu|DingTalk|AlipayClient|(^|[^A-Za-z])QQ[/]/);
if (m) {{ var n = {{MicroMessenger: "微信", Lark: "飞书", Feishu: "飞书", DingTalk: "钉钉", AlipayClient: "支付宝"}}[m[0]] || "QQ", b = document.getElementById("inapp");
  b.textContent = "现在是在" + n + "里打开的：证书提示、录音和下载证书都可能不正常。请点右上角“…”，选“在浏览器打开”（iPhone 用 Safari）。"; b.style.display = "block"; }}</script></body></html>"""
