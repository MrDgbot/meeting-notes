import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const sidecarPort = (() => {
  const raw = process.env.MN_SIDECAR_PORT?.trim();
  if (!raw) return 8770;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 8770;
})();

const sidecarHttp = `http://127.0.0.1:${sidecarPort}`;
const sidecarWs = `ws://127.0.0.1:${sidecarPort}`;

function rewriteProxyHeaders(proxy: {
  on: (ev: string, fn: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void;
}) {
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("origin", sidecarHttp);
    proxyReq.setHeader("host", `127.0.0.1:${sidecarPort}`);
  });
  proxy.on("proxyReqWs", (proxyReq) => {
    proxyReq.setHeader("origin", sidecarHttp);
    proxyReq.setHeader("host", `127.0.0.1:${sidecarPort}`);
  });
}

const rendererPort = (() => {
  const raw = process.env.MN_RENDERER_PORT?.trim();
  if (!raw) return 5173;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 5173;
})();

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src/renderer/src"),
        "@shared": path.resolve(__dirname, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
    server: {
      host: "127.0.0.1",
      port: rendererPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: sidecarHttp,
          changeOrigin: true,
          configure: rewriteProxyHeaders,
        },
        "/ws": {
          target: sidecarWs,
          ws: true,
          changeOrigin: true,
          configure: rewriteProxyHeaders,
        },
        "/lan": {
          target: sidecarHttp,
          changeOrigin: true,
          configure: rewriteProxyHeaders,
        },
        "/static": {
          target: sidecarHttp,
          changeOrigin: true,
          configure: rewriteProxyHeaders,
        },
      },
    },
  },
});
