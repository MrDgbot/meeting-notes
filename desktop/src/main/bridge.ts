import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export interface LoopbackBridgeOptions {
  rendererDir: string;
  getSidecarPort: () => number | null;
}

export class LoopbackBridge {
  private readonly rendererRoot: string;
  private readonly getSidecarPort: () => number | null;
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();
  private port: number | null = null;

  constructor(opts: LoopbackBridgeOptions) {
    this.rendererRoot = path.resolve(opts.rendererDir);
    this.getSidecarPort = opts.getSidecarPort;
  }

  getPort(): number | null {
    return this.port;
  }

  getOrigin(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  private isProxyPath(urlPath: string): boolean {
    return (
      urlPath.startsWith("/api/") ||
      urlPath === "/api" ||
      urlPath.startsWith("/ws/") ||
      urlPath.startsWith("/lan/") ||
      urlPath === "/lan" ||
      urlPath.startsWith("/static/")
    );
  }

  private handleStatic(urlPath: string, res: http.ServerResponse): void {
    const cleanRel = decodeURIComponent(urlPath.split("?")[0] || "/").replace(/^\/+/, "");
    const rel = cleanRel === "" ? "index.html" : cleanRel;
    const candidate = path.resolve(this.rendererRoot, rel);

    // Enforce directory confinement so `..` segments cannot escape rendererDir.
    if (candidate !== this.rendererRoot && !candidate.startsWith(`${this.rendererRoot}${path.sep}`)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ detail: "Forbidden" }));
      return;
    }

    let filePath = candidate;
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const ext = path.extname(filePath);
      if (ext && ext !== ".html") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      filePath = path.join(this.rendererRoot, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  private proxyHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const targetPort = this.getSidecarPort();
    if (!targetPort) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ detail: "本机语音服务正在启动，请稍候…" }));
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = `127.0.0.1:${targetPort}`;
    headers.origin = `http://127.0.0.1:${targetPort}`;

    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: req.url || "/",
        method: req.method || "GET",
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );

    res.on("close", () => {
      if (!res.writableEnded) {
        upstream.destroy();
      }
    });

    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ detail: "本机语音服务正在连接，请稍候…" }));
      } else {
        res.destroy();
      }
    });

    req.pipe(upstream);
  }

  private proxyUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const targetPort = this.getSidecarPort();
    if (!targetPort) {
      clientSocket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      const targetHost = `127.0.0.1:${targetPort}`;
      const targetOrigin = `http://${targetHost}`;
      const lines: string[] = [`${req.method || "GET"} ${req.url || "/"} HTTP/${req.httpVersion || "1.1"}`];
      let hasHost = false;
      let hasOrigin = false;

      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1] ?? "";
        if (!k) continue;
        const lower = k.toLowerCase();
        if (lower === "host") {
          lines.push(`Host: ${targetHost}`);
          hasHost = true;
        } else if (lower === "origin") {
          lines.push(`Origin: ${targetOrigin}`);
          hasOrigin = true;
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
      if (!hasHost) lines.push(`Host: ${targetHost}`);
      if (!hasOrigin) lines.push(`Origin: ${targetOrigin}`);
      lines.push("", "");

      upstream.write(lines.join("\r\n"));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const teardown = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on("error", teardown);
    upstream.on("close", teardown);
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
  }

  async start(): Promise<number> {
    if (this.server && this.port !== null) {
      return this.port;
    }
    const server = http.createServer((req, res) => {
      const urlPath = req.url || "/";
      if (this.isProxyPath(urlPath)) {
        this.proxyHttp(req, res);
        return;
      }
      try {
        this.handleStatic(urlPath, res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("Bad Request");
      }
    });

    server.on("connection", (sock) => {
      this.sockets.add(sock);
      sock.once("close", () => this.sockets.delete(sock));
    });
    server.on("upgrade", (req, sock, head) => {
      if (!this.isProxyPath(req.url || "/")) {
        sock.destroy();
        return;
      }
      this.proxyUpgrade(req, sock as net.Socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const addr = server.address();
    this.server = server;
    this.port = typeof addr === "object" && addr ? addr.port : null;
    if (this.port === null) {
      throw new Error("LoopbackBridge failed to acquire TCP port");
    }
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    server.closeAllConnections?.();
    for (const sock of this.sockets) {
      sock.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
