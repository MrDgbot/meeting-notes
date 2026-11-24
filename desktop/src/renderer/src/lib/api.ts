export interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  timeout?: number;
}

export const OFFLINE_MSG = "连不上本机语音服务，请点击左下角状态栏查看详情";

export function wsUrl(wsPath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${wsPath}`;
}

export async function api<T = unknown>(url: string, opt: ApiOptions = {}): Promise<T> {
  const { timeout = 30000, signal: extSignal, body, headers, ...rest } = opt;
  const initHeaders = new Headers(headers);
  let reqBody: BodyInit | undefined;

  if (body !== undefined && body !== null) {
    if (typeof body === "string" || body instanceof FormData || body instanceof Blob) {
      reqBody = body;
    } else {
      reqBody = JSON.stringify(body);
      if (!initHeaders.has("Content-Type")) {
        initHeaders.set("Content-Type", "application/json");
      }
    }
  }

  let ac: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let onExtAbort: (() => void) | null = null;

  if (timeout > 0 || extSignal) {
    ac = new AbortController();
    if (extSignal) {
      if (extSignal.aborted) {
        ac.abort(extSignal.reason);
      } else {
        onExtAbort = () => ac?.abort(extSignal.reason);
        extSignal.addEventListener("abort", onExtAbort, { once: true });
      }
    }
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        ac?.abort();
      }, timeout);
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: initHeaders,
      body: reqBody,
      signal: ac?.signal,
    });
  } catch (err) {
    if (timedOut) throw new Error("请求超时，请检查本机后端服务状态");
    if (extSignal?.aborted) throw err;
    throw new Error(OFFLINE_MSG);
  } finally {
    if (timer) clearTimeout(timer);
    if (extSignal && onExtAbort) extSignal.removeEventListener("abort", onExtAbort);
  }

  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : "";
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export interface NdjsonEvent {
  type: "status" | "delta" | "done" | "error";
  msg?: string;
  text?: string;
  minutes?: unknown;
  summary?: unknown;
  report?: unknown;
}

export async function streamNd(
  url: string,
  body: unknown,
  onEvent: (ev: NdjsonEvent) => void,
  opt: { signal?: AbortSignal } = {},
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opt.signal,
    });
  } catch (err) {
    if (opt.signal?.aborted) throw err;
    throw new Error(OFFLINE_MSG);
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || res.statusText);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("后端未返回流式数据");

  const dec = new TextDecoder();
  let buf = "";
  const drain = (chunk: string) => {
    buf += chunk;
    for (let idx = buf.indexOf("\n"); idx >= 0; idx = buf.indexOf("\n")) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onEvent(JSON.parse(line) as NdjsonEvent);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      drain(dec.decode());
      if (buf.trim()) onEvent(JSON.parse(buf) as NdjsonEvent);
      break;
    }
    drain(dec.decode(value, { stream: true }));
  }
}

export function uploadWithProgress<T = unknown>(
  url: string,
  formData: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || "null");
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve(data as T);
        } else {
          reject(new Error(data?.detail || `上传失败 (${xhr.status})`));
        }
      } catch {
        reject(new Error(`上传失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error(OFFLINE_MSG));
    xhr.send(formData);
  });
}
