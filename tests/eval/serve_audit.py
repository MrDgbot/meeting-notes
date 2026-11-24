"""审计页的小服务：静态文件 + 保存复听结果。

  python3 tests/eval/serve_audit.py   → http://127.0.0.1:8765/
复听结果写到 ~/eval-out/claims/weekly/audit/reviews.json。
"""
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial

A = Path.home() / "eval-out/claims/weekly/audit"
F = A / "reviews.json"
LOCK = threading.Lock()


class H(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path.rstrip("/") != "/api/review":
            return self.send_error(404)
        x = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        rid = str(x.pop("id", ""))
        if not rid.startswith("W"):
            return self.send_error(400)
        with LOCK:
            d = json.loads(F.read_text()) if F.exists() else {}
            d[rid] = x
            F.write_text(json.dumps(d, ensure_ascii=False, indent=1))
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", 8765), partial(H, directory=str(A))).serve_forever()
