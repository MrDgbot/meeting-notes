import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopbackBridge } from "../bridge";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe("LoopbackBridge static serving, header rewrite, and WebSocket proxy", () => {
  it("serves renderer assets, blocks path traversal, rewrites Host/Origin on /api, and proxies WebSocket upgrades", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mn-bridge-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>OK</body></html>");
    fs.writeFileSync(path.join(dir, "pcm-worklet.js"), "// worklet");

    const captured: { api: http.IncomingHttpHeaders | null; ws: http.IncomingHttpHeaders | null } = {
      api: null,
      ws: null,
    };

    const mockUpstream = http.createServer((req, res) => {
      captured.api = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    const upSockets = new Set<net.Socket>();
    mockUpstream.on("connection", (s) => {
      upSockets.add(s);
      s.once("close", () => upSockets.delete(s));
    });
    mockUpstream.on("upgrade", (req, sock) => {
      captured.ws = req.headers;
      const key = String(req.headers["sec-websocket-key"] || "");
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      sock.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );
      sock.on("data", (chunk) => {
        sock.write(chunk);
      });
    });

    await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of upSockets) s.destroy();
          mockUpstream.closeAllConnections();
          mockUpstream.close(() => resolve());
        }),
    );
    const upPort = (mockUpstream.address() as net.AddressInfo).port;

    const bridge = new LoopbackBridge({ rendererDir: dir, getSidecarPort: () => upPort });
    const bridgePort = await bridge.start();
    cleanups.push(() => bridge.stop());

    // 1. Static asset & SPA fallback
    const rIndex = await fetch(`http://127.0.0.1:${bridgePort}/`);
    expect(rIndex.status).toBe(200);
    expect(await rIndex.text()).toContain("OK");

    const rWorklet = await fetch(`http://127.0.0.1:${bridgePort}/pcm-worklet.js`);
    expect(rWorklet.status).toBe(200);
    expect(await rWorklet.text()).toBe("// worklet");

    // 2. Directory traversal blocked cleanly via raw socket (fetch normalizes `..`)
    const travRes = await new Promise<string>((resolve) => {
      const s = net.connect(bridgePort, "127.0.0.1", () => {
        s.write(
          `GET /../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1:${bridgePort}\r\nConnection: close\r\n\r\n`,
        );
      });
      let out = "";
      s.on("data", (d) => {
        out += d.toString("utf8");
      });
      s.on("end", () => resolve(out));
    });
    expect(travRes.startsWith("HTTP/1.1 403")).toBe(true);

    // 3. /api HTTP proxy rewrites Host & Origin to upstream sidecar port (satisfying lan.Guard)
    const rApi = await fetch(`http://127.0.0.1:${bridgePort}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${bridgePort}` },
    });
    expect(rApi.status).toBe(200);
    expect(await rApi.json()).toEqual({ ok: true, path: "/api/health" });
    expect(captured.api?.host).toBe(`127.0.0.1:${upPort}`);
    expect(captured.api?.origin).toBe(`http://127.0.0.1:${upPort}`);

    // 4. /ws WebSocket upgrade proxy rewrites Host & Origin and pipes bidirectional frames
    const wsPayload = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(bridgePort, "127.0.0.1", () => {
        sock.write(
          [
            "GET /ws/ambient HTTP/1.1",
            `Host: 127.0.0.1:${bridgePort}`,
            `Origin: http://127.0.0.1:${bridgePort}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
      let buf = Buffer.alloc(0);
      let upgraded = false;
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx >= 0) {
            upgraded = true;
            buf = buf.subarray(idx + 4);
            sock.write("PING_FRAME");
          }
        }
        if (upgraded && buf.length >= 10) {
          const out = buf.toString("utf8");
          sock.destroy();
          resolve(out);
        }
      });
      sock.on("error", reject);
    });
    expect(wsPayload).toBe("PING_FRAME");
    expect(captured.ws?.host).toBe(`127.0.0.1:${upPort}`);
    expect(captured.ws?.origin).toBe(`http://127.0.0.1:${upPort}`);
  });
});
