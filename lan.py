"""局域网访问（默认关闭）：同一 Wi-Fi 下的平板、手机用浏览器打开会议记录。

- 另开一个 HTTPS 端口（默认 8771）对局域网开放；原来的 127.0.0.1:8770 不变，本机访问不需要口令。
- 不是从本机来的请求都要先用访问口令登录（Cookie，30 天）；口令只存 PBKDF2 哈希。改口令、
  “让所有设备退出”后旧的登录全部失效；连续输错会锁一段时间。
- 证书：第一次开启时在 data/lan/ 生成这台电脑专用的根证书（5 年）和服务器证书（800 天，含本机局域网 IP 和 xxx.local）。
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
import math
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import weakref
from datetime import UTC, datetime, timedelta
from html import escape
from pathlib import Path
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
_cfg_lock = threading.RLock()


def _ensure_dir(d: Path | None = None) -> None:
    target = d or DIR
    target.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(target, 0o700)


def _write_atomic(path: Path, data: bytes, *, secret: bool = False) -> None:
    """原子写文件：先建唯一临时文件（敏感文件以 0o600 创建，无 0o644 窗口）再 os.replace。"""
    if secret:
        _ensure_dir(path.parent)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    fd = None
    tmp = None
    mode = 0o600 if secret else 0o644
    for _ in range(16):
        cand = path.parent / f".{path.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
            fd = os.open(cand, flags, mode)
            tmp = cand
            break
        except FileExistsError:
            continue
    if fd is None or tmp is None:
        raise OSError(f"cannot create temp file for {path}")
    try:
        with os.fdopen(fd, "wb") as f:
            if secret and hasattr(os, "fchmod"):
                os.fchmod(f.fileno(), 0o600)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise


def cfg() -> dict:
    global _cfg
    with _cfg_lock:
        if _cfg is None:
            _cfg = {**DEFAULTS, **(store.read_json(CFG) or {})}
        return dict(_cfg)


def _save(**kw) -> dict:
    global _cfg
    with _cfg_lock:
        c = {**cfg(), **kw}
        _write_atomic(CFG, (json.dumps(c, ensure_ascii=False, indent=1) + "\n").encode("utf-8"), secret=True)
        _cfg = c
        return dict(c)


# ---------------- 口令和登录 ----------------
def _pbkdf(pw: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()


def set_password(pw: str) -> None:
    salt = secrets.token_hex(16)
    _save(pw_salt=salt, pw_hash=_pbkdf(pw, salt), secret=secrets.token_hex(32))  # 换口令 = 旧登录全部失效


def check_password(pw: str) -> bool:
    c = cfg()
    if not c.get("pw_hash") or not c.get("pw_salt"):
        return False
    try:
        return hmac.compare_digest(_pbkdf(pw, c["pw_salt"]), c["pw_hash"])
    except ValueError:
        return False


def logout_all() -> None:
    _save(secret=secrets.token_hex(32))


def _sign(ts: str) -> str:
    return hmac.new(bytes.fromhex(cfg()["secret"]), ts.encode(), "sha256").hexdigest()


def make_token() -> str:
    ts = str(int(time.time()))
    return f"{ts}.{_sign(ts)}"


def valid_token(tok: str | None) -> bool:
    c = cfg()
    secret = c.get("secret")
    if not tok or "." not in tok or not secret:
        return False
    ts, sig = tok.split(".", 1)
    if not (ts.isascii() and ts.isdigit()):
        return False
    try:
        issued = int(ts)
        expected = hmac.new(bytes.fromhex(secret), ts.encode(), "sha256").hexdigest()
    except ValueError:
        return False
    now = time.time()
    if issued > now + 60 or now - issued >= MAX_AGE:
        return False
    return hmac.compare_digest(sig, expected)


_auth_lock = threading.Lock()
_login_lock = threading.Lock()  # 串行化口令校验，避免高并发突发请求绕过 5 次 / 20 次锁定阈值
_fails: dict[str, list] = {}  # ip -> [连续输错次数, 锁到什么时候, 上次失败时间]
# 换着 IP 猜（IPv6 临时地址、多台设备）：所有来源合计 10 分钟内错 20 次，全部暂停登录 10 分钟
_all_fails: list[float] = []
_all_lock = [0.0]
GLOBAL_FAILS, GLOBAL_WINDOW, GLOBAL_LOCK = 20, 600, 600
FAIL_TTL = 86400  # 24 小时无新失败则自动过期，防内存增长及跨月误累计
MAX_FAIL_ENTRIES = 1024


def _norm_ip(ip: str | None) -> str:
    if not ip:
        return "?"
    try:
        a = ipaddress.ip_address(ip)
        if a.version == 6 and a.ipv4_mapped:
            a = a.ipv4_mapped
        return str(a)
    except ValueError:
        return ip


def _prune_fails(now: float, keep: str | None = None) -> None:
    stale = [k for k, f in _fails.items() if k != keep and now >= f[1] and now - (f[2] if len(f) > 2 else 0.0) > FAIL_TTL]
    for k in stale:
        _fails.pop(k, None)
    if len(_fails) > MAX_FAIL_ENTRIES:
        order = sorted((kv for kv in _fails.items() if kv[0] != keep),
                       key=lambda kv: (kv[1][1] > now, kv[1][2] if len(kv[1]) > 2 else 0.0))
        for k, _ in order[: len(_fails) - MAX_FAIL_ENTRIES]:
            _fails.pop(k, None)


def _locked(ip: str) -> int:
    ip = _norm_ip(ip)
    now = time.time()
    with _auth_lock:
        f = _fails.get(ip)
        until = max(f[1] if f else 0.0, _all_lock[0])
    return math.ceil(until - now) if until > now else 0


def _failed(ip: str) -> None:
    ip = _norm_ip(ip)
    now = time.time()
    with _auth_lock:
        f = _fails.get(ip)
        if f is None or (now >= f[1] and now - (f[2] if len(f) > 2 else 0.0) > FAIL_TTL):
            f = [0, 0.0, now]
            _fails[ip] = f
        elif len(f) < 3:
            f.append(now)
        f[0] += 1
        f[2] = now
        if f[0] >= 5:  # 第 5 次起每次多锁一倍：30 秒、1 分钟、2 分钟……最多 1 小时
            f[1] = now + min(3600, 30 * (1 << min(f[0] - 5, 7)))
        _prune_fails(now, keep=ip)
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
    return ip.is_loopback or any(ip in n for n in LOCAL_CLIENTS)


# 当作本机的来源地址（默认没有）。Docker 端口映射进来的请求，来源是网桥网关（如 172.17.0.1），不是 127.0.0.1：
# 只把端口映射到宿主机的 127.0.0.1（docker run -p 127.0.0.1:8770:8770）时，才可以把网关地址加进来
LOCAL_CLIENTS = [ipaddress.ip_network(n.strip(), strict=False)
                 for n in (os.environ.get("MN_LOCAL_CLIENTS") or "").split(",") if n.strip()]


_hosts_lock = threading.Lock()
_hosts = [0.0, set()]  # [上次刷新时间, 允许的 Host]
_hosts_unknown_ts = [0.0]  # 上次因未知 Host 触发强制刷新的时间
HOST_TTL = 60.0
HOST_UNKNOWN_COOLDOWN = 30.0
_hosts_async_locks: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
EXTRA_HOSTS = {h.strip().lower() for h in (os.environ.get("MN_ALLOWED_HOSTS") or "").split(",") if h.strip()}


def _get_hosts_async_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _hosts_async_locks.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _hosts_async_locks[loop] = lock
    return lock


def _tailscale_candidates() -> tuple[str, ...]:
    if sys.platform == "darwin":
        return ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
    if sys.platform == "win32":
        return ("tailscale", os.path.join(os.environ.get("ProgramFiles") or r"C:\Program Files", "Tailscale", "tailscale.exe"))
    return ("tailscale",)


def _tailscale_names() -> set[str]:
    for exe in _tailscale_candidates():
        resolved = shutil.which(exe) if os.sep not in exe and "/" not in exe else (exe if os.path.isfile(exe) else None)
        if not resolved:
            continue
        try:
            out = subprocess.run([resolved, "status", "--json"], capture_output=True, text=True, timeout=2, check=False).stdout
            name = (json.loads(out).get("Self") or {}).get("DNSName", "").rstrip(".").lower()
            return {name} if name else set()
        except (OSError, subprocess.SubprocessError, ValueError):
            return set()  # 已找到本机二进制但服务未运行/出错，不再重复尝试其他路径
    return set()


def _compute_allowed_hosts() -> set[str]:
    return ({"127.0.0.1", "localhost", "::1"} | {a["ip"] for a in addresses()} | {hostname().lower()}
            | _tailscale_names() | EXTRA_HOSTS)


def allowed_hosts(refresh: bool = False) -> set[str]:
    """能用来打开会议记录的主机名：本机回环、本机各网卡 IP、xxx.local、Tailscale 名字，以及 MN_ALLOWED_HOSTS 里加的。"""
    now = time.time()
    with _hosts_lock:
        if not refresh and _hosts[1] and now - _hosts[0] <= HOST_TTL:
            return set(_hosts[1])
    computed = _compute_allowed_hosts()
    now = time.time()
    with _hosts_lock:
        _hosts[1] = computed
        _hosts[0] = now
        return set(computed)


async def allowed_hosts_async(refresh: bool = False) -> set[str]:
    """异步单飞刷新允许的 Host 集合，避免阻塞 asyncio 事件循环。"""
    now = time.time()
    with _hosts_lock:
        if not refresh and _hosts[1] and now - _hosts[0] <= HOST_TTL:
            return set(_hosts[1])
    async with _get_hosts_async_lock():
        now = time.time()
        with _hosts_lock:
            if not refresh and _hosts[1] and now - _hosts[0] <= HOST_TTL:
                return set(_hosts[1])
        computed = await asyncio.to_thread(_compute_allowed_hosts)
        now = time.time()
        with _hosts_lock:
            _hosts[1] = computed
            _hosts[0] = now
            return set(computed)


def _header(scope, name: bytes) -> str | None:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return None


def host_name(host: str) -> str:
    h = host.strip().lower()
    if h.startswith("["):
        end = h.find("]")
        if end == -1:
            return h
        rest = h[end + 1:]
        if rest and not (rest.startswith(":") and rest[1:].isascii() and rest[1:].isdigit()):
            return h
        return h[1:end]
    if h.count(":") == 1:
        name, port = h.rsplit(":", 1)
        return name if (port.isascii() and port.isdigit()) else h
    return h


def _claim_unknown_host_refresh() -> bool:
    now = time.time()
    with _hosts_lock:
        if now - _hosts[0] > HOST_UNKNOWN_COOLDOWN and now - _hosts_unknown_ts[0] > HOST_UNKNOWN_COOLDOWN:
            _hosts_unknown_ts[0] = now
            return True
        return False


def host_ok(scope) -> bool:
    """防 DNS rebinding：恶意网页把自己的域名临时解析到 127.0.0.1 时，浏览器发来的 Host 还是那个域名。"""
    h = host_name(_header(scope, b"host") or "")
    if not h:
        return False
    if h in allowed_hosts():
        return True
    if _claim_unknown_host_refresh():  # 刚换了网络 / IP：限频重新取一次再判断
        return h in allowed_hosts(refresh=True)
    return False


async def host_ok_async(scope) -> bool:
    """Guard 中间件使用的异步 Host 校验：子进程刷新放到线程池单飞执行，不阻塞事件循环。"""
    h = host_name(_header(scope, b"host") or "")
    if not h:
        return False
    if h in await allowed_hosts_async():
        return True
    if _claim_unknown_host_refresh():
        return h in await allowed_hosts_async(refresh=True)
    return False


UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def origin_ok(scope) -> bool:
    """改数据的请求和 WebSocket：浏览器带的 Origin 必须就是这个网站本身（同协议、同 Host）。
    没有 Origin 的一般不是浏览器发的（如 curl），但若带 Sec-Fetch-Site: cross-site 仍拒绝。"""
    if scope["type"] == "http" and scope.get("method") not in UNSAFE:
        return True
    origin = _header(scope, b"origin")
    if origin is None:
        sfs = (_header(scope, b"sec-fetch-site") or "").strip().lower()
        return sfs != "cross-site"
    if origin == "null":
        return False
    parts = urlsplit(origin)
    scheme = parts.scheme.lower()
    scope_scheme = (scope.get("scheme") or "").lower()
    if scope_scheme in ("https", "wss"):
        expected = "https"
    elif scope_scheme in ("http", "ws"):
        expected = "http"
    else:
        expected = ""
    if expected and scheme != expected:
        return False
    if not expected and scheme not in ("http", "https"):
        return False
    host = (_header(scope, b"host") or "").strip().lower()
    return bool(host) and parts.netloc.lower() == host


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
        if not await host_ok_async(scope):
            log.warning("rejected Host %r for %s", _header(scope, b"host"), scope["path"])
            return await self._deny(scope, receive, send, 421, "这个地址不能用来打开会议记录（Host 不是这台电脑的地址）")
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
    n = ""
    if sys.platform == "darwin":
        try:
            n = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3, check=False).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            n = ""
    return (n or socket.gethostname().split(".")[0]) + ".local"


def addresses() -> list[dict]:
    """本机的 IPv4 地址。Wi-Fi / 有线（有广播地址的网卡）排前面，其次 Tailscale（100.64/10）；
    代理软件的虚拟网卡（198.18/15 之类）手机连不上，只放进证书、不列出来。"""
    res = []
    for iface, addr, bcast in _ifaces():
        ip = ipaddress.ip_address(addr)
        if ip.is_loopback or ip.is_link_local:
            continue
        kind = ("lan" if bcast and not iface.startswith(VIRTUAL_IFACES) and ip.is_private
                else "tailscale" if ip in ipaddress.ip_network("100.64.0.0/10") else "other")
        res.append({"ip": str(ip), "iface": iface, "kind": kind})
    order = {"lan": 0, "tailscale": 1, "other": 2}
    return sorted(res, key=lambda a: (order[a["kind"]], not a["iface"].startswith(("en", "eth", "wl")), a["iface"]))


# 手机连不上的虚拟网卡：macOS 的 utun，Linux 上 Docker / 虚拟机的网桥
VIRTUAL_IFACES = ("utun", "lo", "docker", "br-", "veth", "virbr", "cni", "flannel", "tailscale")


def _ifaces_fallback() -> list[tuple[str, str, bool]]:
    """纯 Python 回退（极简 Linux 容器里没有 ip / ifconfig 时使用）：通过 UDP 路由探测 + getaddrinfo 取本机 IPv4。"""
    ips: set[str] = set()
    for target in (("10.255.255.255", 1), ("192.0.2.1", 80)):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(target)
                ip = s.getsockname()[0]
                if ip and not ip.startswith("127."):
                    ips.add(ip)
        except OSError:
            pass
    try:
        for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = ai[4][0]
            if ip and not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return [("", ip, True) for ip in sorted(ips)]


def _ifaces() -> list[tuple[str, str, bool]]:
    """[(网卡名, IPv4, 有没有广播地址)]。macOS 用 ifconfig，Linux 用 ip（新系统多半没装 ifconfig），
    两者都不可用时（如精简容器）用纯 Python 回退；Windows 用本机名解析出的地址。"""
    if sys.platform == "win32":
        try:
            ips = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
        except OSError:
            return []
        return [("", ip, True) for ip in sorted(ips)]
    res, iface = [], ""
    try:
        out = subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True, timeout=3,
                             check=False).stdout if sys.platform == "linux" else ""
    except (OSError, subprocess.SubprocessError):
        out = ""
    if out:  # 2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global eth0 …
        for line in out.splitlines():
            m = re.match(r"^\d+:\s+(\S+)\s+inet (\d+\.\d+\.\d+\.\d+)", line)
            if m:
                res.append((m.group(1), m.group(2), " brd " in line))
        return res
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return _ifaces_fallback()
    for line in out.splitlines():
        m = re.match(r"^(\S+): flags", line)
        if m:
            iface = m.group(1)
            continue
        m = re.match(r"\s+inet (\d+\.\d+\.\d+\.\d+)", line)
        if m:
            res.append((iface, m.group(1), "broadcast" in line))
    return res or _ifaces_fallback()


def _x509():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    return x509, hashes, serialization, rsa, ExtendedKeyUsageOID, NameOID


def _write_key(path, key, serialization) -> None:
    _write_atomic(path, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), secret=True)


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
        try:
            key = serialization.load_pem_private_key(CA_KEY.read_bytes(), None)
            cert = x509.load_pem_x509_certificate(CA_PEM.read_bytes())
        except Exception:  # noqa: BLE001
            log.warning("corrupt LAN root CA, regenerating", exc_info=True)
            with contextlib.suppress(OSError):
                CA_KEY.unlink(missing_ok=True)
            with contextlib.suppress(OSError):
                CA_PEM.unlink(missing_ok=True)
        else:
            try:
                cert.extensions.get_extension_for_class(x509.NameConstraints)
                return key, cert
            except x509.ExtensionNotFound:
                # 旧版根证书没有名称限制：作废（删掉私钥），换一张有限制的。装过旧证书的设备要重新安装
                log.warning("replacing LAN root CA without name constraints")
                CA_PEM.replace(DIR / "ca-old-unconstrained.pem")
                CA_KEY.unlink()
                _save(ca_replaced=int(time.time()))
    _ensure_dir()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # CN 最长 64 字节（中文一个字 3 字节）：主机名很长时（如 CI 的虚拟机）截短，只是显示用
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"会议记录 本机根证书（{hostname().removesuffix('.local')[:28]}）"),
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
    _write_atomic(CA_PEM, cert.public_bytes(serialization.Encoding.PEM), secret=False)
    SRV_PEM.unlink(missing_ok=True)
    log.info("created local root CA")
    return key, cert


def ensure_certs() -> bool:
    """证书不存在、快过期、或者本机 IP / 名字不在证书里时重签服务器证书。返回是否重签了。"""
    x509, hashes, serialization, rsa, EKU, NameOID = _x509()
    ca_key, ca = _load_ca()
    host = hostname()
    # 只放根证书允许的名字（名称限制之外的名字会让整张证书失效）：局域网 / Tailscale IP、xxx.local、Tailscale 名字及 MN_ALLOWED_HOSTS 中的合法内网项
    ips = {a["ip"] for a in addresses() if _permitted_ip(a["ip"])}
    dns = {n for n in {host.lower(), *_tailscale_names()} if _permitted_dns(n)}
    for extra in EXTRA_HOSTS:
        h = host_name(extra)
        try:
            a = ipaddress.ip_address(h)
        except ValueError:
            if _permitted_dns(h):
                dns.add(h)
        else:
            if a.version == 4 and _permitted_ip(str(a)):
                ips.add(str(a))
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
    # 主机名超过 CN 的 64 字节上限时不放进 CN（截短的主机名会被 OpenSSL 拿去和名称限制比）；证书靠 SAN 认名字
    cn = host if len(host.encode()) <= 64 else "会议记录 服务器证书"
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
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
    _write_atomic(SRV_PEM, cert.public_bytes(serialization.Encoding.PEM) + ca.public_bytes(serialization.Encoding.PEM), secret=False)
    log.info("issued LAN server certificate for %s %s", sorted(dns), sorted(ips))
    return True


def ca_info() -> dict | None:
    if not CA_PEM.exists():
        return None
    try:
        x509, hashes, serialization, *_ = _x509()
        ca = x509.load_pem_x509_certificate(CA_PEM.read_bytes())
        fp = ca.fingerprint(hashes.SHA256()).hex().upper()
        return {"der": ca.public_bytes(serialization.Encoding.DER), "sha256": ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)),
                "name": ca.subject.rfc4514_string()}
    except Exception:  # noqa: BLE001
        log.warning("corrupt LAN CA certificate at %s", CA_PEM, exc_info=True)
        return None


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


def _bind(port: int) -> socket.socket:
    """监听 [::]:port，同时收 IPv4（xxx.local 可能先解析出 IPv6）；没有 IPv6 的机器（如关了 IPv6 的容器）退回 0.0.0.0。"""
    for fam, addr in ((socket.AF_INET6, "::"), (socket.AF_INET, "0.0.0.0")):
        sock = None
        try:
            sock = socket.socket(fam, socket.SOCK_STREAM)
            if sys.platform == "win32":  # Windows 的 SO_REUSEADDR 能抢别的程序正在监听的端口，改用独占
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if fam == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            sock.bind((addr, port))
            sock.listen(128)
            sock.setblocking(False)
            return sock
        except OSError as e:
            if sock:
                sock.close()
            if fam == socket.AF_INET6 and e.errno in (errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL):
                continue
            raise
    raise OSError(errno.EAFNOSUPPORT, "没有可用的网络")


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
                self.error = "生成安全证书失败，请检查数据目录权限"
                return
            base_port = int(c["port"])
            chosen_port = None
            sock = None
            last_err = ""
            candidates = [base_port] + [
                p for p in range(base_port + 1, min(65535, base_port + 12)) if p != MAIN_PORT
            ]
            for cand_port in candidates:
                if cand_port == MAIN_PORT:
                    continue
                if await asyncio.to_thread(_listening, cand_port):
                    last_err = f"端口 {cand_port} 已被占用，请换一个端口"
                    continue
                try:
                    sock = _bind(cand_port)
                    chosen_port = cand_port
                    break
                except OSError as e:
                    if e.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)):
                        last_err = f"端口 {cand_port} 已被占用，请换一个端口"
                    else:
                        last_err = f"无法监听端口 {cand_port}，请检查网络或防火墙权限"
            if sock is None or chosen_port is None:
                self.error = last_err or f"端口 {base_port} 不可用，请换一个端口"
                return
            port = chosen_port
            if port != base_port:
                await asyncio.to_thread(_save, port=port)
            config = uvicorn.Config(self.app, lifespan="off", log_config=None, proxy_headers=False, log_level="warning",
                                    ssl_certfile=str(SRV_PEM), ssl_keyfile=str(SRV_KEY), timeout_graceful_shutdown=3)
            try:
                config.load()
            except (Exception, SystemExit) as e:  # noqa: BLE001 —— uvicorn 出错时会 sys.exit，不能让它带走主服务
                sock.close()
                self.error = f"局域网服务启动失败：{e}"
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
            if self.server is server and self.watch:
                self.watch.cancel()
                self.watch = None

    async def _watch_ip(self) -> None:
        """每分钟看一下 IP 有没有变：变了就重签服务器证书，新连接直接用新证书，不用重启。"""
        while True:
            await asyncio.sleep(60)
            try:
                async with self._lock:
                    if not self.running or not self.ssl:
                        continue
                    if await asyncio.to_thread(ensure_certs):
                        await asyncio.to_thread(self.ssl.load_cert_chain, str(SRV_PEM), str(SRV_KEY))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("refresh cert")

    async def _stop(self) -> None:
        if self.watch:
            watch = self.watch
            self.watch = None
            watch.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watch
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
        raise HTTPException(403, "局域网访问的设置只能在这台电脑上修改")


def status(request: Request | None = None) -> dict:
    c = cfg()
    port = int(c["port"])
    urls = []
    if server.running:
        for a in addresses():
            if a["kind"] == "other":
                continue
            urls.append({"url": f"https://{a['ip']}:{port}", "label": "Wi-Fi / 有线" if a["kind"] == "lan" else "Tailscale"})
        urls.append({"url": f"https://{hostname()}:{port}", "label": "用名字访问（iPhone、iPad、电脑可用，IP 变了也不用换）"})
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
    raw_pw = body.get("password")
    if raw_pw is None:
        pw = ""
    elif isinstance(raw_pw, str):
        pw = raw_pw.strip()
    else:
        raise HTTPException(400, "访问口令格式不正确")
    if pw and len(pw) < 6:
        raise HTTPException(400, "访问口令至少 6 位")

    raw_port = body.get("port")
    if raw_port is None or raw_port == "":
        port = int(c["port"])
    else:
        if isinstance(raw_port, bool):
            raise HTTPException(400, f"端口要在 1024–65535 之间，且不能和本机端口 {MAIN_PORT} 相同")
        try:
            port = int(raw_port)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, f"端口要在 1024–65535 之间，且不能和本机端口 {MAIN_PORT} 相同") from e
    if not 1024 <= port <= 65535 or port == MAIN_PORT:
        raise HTTPException(400, f"端口要在 1024–65535 之间，且不能和本机端口 {MAIN_PORT} 相同")

    enabled = bool(body["enabled"]) if "enabled" in body and body["enabled"] is not None else bool(c["enabled"])
    generated_pw = ""
    if enabled and not (pw or c["pw_hash"]):
        generated_pw = f"{secrets.randbelow(900000) + 100000}"
        pw = generated_pw

    changed = bool(pw) or enabled != c["enabled"] or port != int(c["port"]) or (enabled and not server.running)
    if pw:
        await asyncio.to_thread(set_password, pw)
    await asyncio.to_thread(_save, enabled=enabled, port=port)
    if changed:
        await server.apply()
    res = await asyncio.to_thread(status, request)
    if generated_pw:
        res["generated_password"] = generated_pw
    return res


@router.post("/api/lan/logout-all")
def lan_logout_all(request: Request):
    _only_here(request)
    logout_all()
    return status(request)


@router.get("/lan/ca.cer")
def ca_cert():
    ca = ca_info()
    if not ca:
        raise HTTPException(404, "还没有生成证书：请先在电脑的「设置 · 手机访问」里开启局域网访问")
    return Response(ca["der"], media_type="application/x-x509-ca-cert",
                    headers={"Content-Disposition": 'attachment; filename="meeting-notes-ca.cer"'})


@router.get("/lan/icon.png")
def icon():  # 添加到主屏幕时的图标；登录前也要能拿到
    return FileResponse(store.BASE / "static" / "icon.png", media_type="image/png", headers={"Cache-Control": "max-age=86400"})


def _next(v: str) -> str:
    return v if v.startswith("/") and not v.startswith("//") and "\\" not in v else "/"


@router.get("/lan/login")
def login_page(request: Request, next: str = "/"):
    if is_local(request.scope) or valid_token(request.cookies.get(COOKIE)):
        return RedirectResponse(_next(next), 303)
    return HTMLResponse(_login_html(_next(next), ""), headers={"Cache-Control": "no-store"})


@router.post("/lan/login")
def login(request: Request, password: str = Form(""), next: str = Form("/")):
    ip = _norm_ip(request.client.host if request.client else None)
    wait = _locked(ip)
    if wait:
        return HTMLResponse(_login_html(_next(next), f"输错次数太多，请 {wait} 秒后再试"), 429,
                            headers={"Cache-Control": "no-store"})
    with _login_lock:
        wait = _locked(ip)
        if wait:
            return HTMLResponse(_login_html(_next(next), f"输错次数太多，请 {wait} 秒后再试"), 429,
                                headers={"Cache-Control": "no-store"})
        if not check_password(password):
            _failed(ip)
            log.warning("LAN login failed from %s", ip)
            w = _locked(ip)
            return HTMLResponse(_login_html(_next(next), "口令不对" if not w else f"输错次数太多，请 {w} 秒后再试"), 401,
                                headers={"Cache-Control": "no-store"})
        with _auth_lock:
            _fails.pop(ip, None)
    log.info("LAN login from %s", ip)
    resp = RedirectResponse(_next(next), 303)
    resp.set_cookie(COOKIE, make_token(), max_age=MAX_AGE, httponly=True, secure=True, samesite="lax")
    return resp


@router.post("/lan/logout")
def logout():
    resp = RedirectResponse("/lan/login", 303)
    resp.delete_cookie(COOKIE, httponly=True, secure=True, samesite="lax")
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
<p>这是电脑上的会议记录服务。输入在电脑上“设置 · 平板、手机访问”里设好的访问口令。</p>
<input type="password" name="password" placeholder="访问口令" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="{escape(nxt)}"><button>登录</button>
<div class="err">{escape(err)}</div><div class="small">登录后这台设备 30 天内不用再输。</div>
<details><summary>浏览器提示“不安全”，或者 iPhone / iPad 上录不了音？</summary>
<p style="margin-top:8px">这是电脑自己签发的证书。装上并信任它以后浏览器不再提示。<b>建议在 iPhone / iPad 上装好</b>：不装的话每次都会提示“不安全”，部分 iOS 版本上录音（实时转写连接）会连不上。</p>
{'<a class="btn" href="/lan/ca.cer">下载证书</a>' if ca else '<span class="small">（还没有生成证书）</span>'}
<ol><li><b>iPhone / iPad</b>：用 Safari 点“下载证书”并允许下载，到“设置 → 已下载的描述文件”安装；再到“设置 → 通用 → 关于本机 → 证书信任设置”，打开“会议记录 本机根证书”的开关。</li>
<li><b>安卓</b>：点“下载证书”，到“设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书”选择刚下载的文件（不同品牌的菜单名称略有不同）。</li></ol>
{f'<div class="small">证书指纹（可以和电脑设置页里显示的对一下）：<br><code>{fp}</code></div>' if ca else ''}
</details></form>
<script>/* 网址里 # 后面的部分（要打开的那场会议）服务器看不到：带到表单地址上，输错一次、登录跳转后都还在 */
document.forms[0].action = "/lan/login" + location.hash;
/* 微信、飞书等应用里扫码打开：证书、录音都可能不正常，先提示换浏览器 */
var m = navigator.userAgent.match(/MicroMessenger|Lark|Feishu|DingTalk|AlipayClient|(^|[^A-Za-z])QQ[/]/);
if (m) {{ var n = {{MicroMessenger: "微信", Lark: "飞书", Feishu: "飞书", DingTalk: "钉钉", AlipayClient: "支付宝"}}[m[0]] || "QQ", b = document.getElementById("inapp");
  b.textContent = "现在是在" + n + "里打开的：证书提示、录音和下载证书都可能不正常。请点右上角“…”，选“在浏览器打开”（iPhone 用 Safari）。"; b.style.display = "block"; }}</script></body></html>"""
