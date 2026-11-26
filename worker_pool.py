"""Persistent JSONL subprocess worker pool for out-of-process diarizers."""
from __future__ import annotations

import atexit
from collections import deque
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

_NO_WIN = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


class PersistentJsonlWorker:
    """Manages a persistent `--serve` subprocess communicating via single-line JSONL."""

    def __init__(
        self,
        name: str,
        script_path: Path | str,
        idle_timeout_s: float = 300.0,
        *,
        startup_timeout_s: float = 120.0,
        stderr_lines: int = 200,
        env: dict[str, str] | None = None,
    ) -> None:
        self.name = str(name)
        self.script_path = Path(script_path)
        self.idle_timeout_s = float(idle_timeout_s)
        self.startup_timeout_s = float(startup_timeout_s)
        self.env = dict(env) if env else None

        self._lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._stdout_queue: queue.Queue[str | None] | None = None
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._stderr_buf: deque[str] = deque(maxlen=max(10, int(stderr_lines)))
        self._stderr_lock = threading.Lock()

        self.last_used: float = 0.0
        self.device: str | None = None
        self.starts: int = 0
        self.requests: int = 0

    def stderr_tail(self, limit: int = 20) -> list[str]:
        """Return up to the last `limit` captured stderr lines."""
        with self._stderr_lock:
            lines = list(self._stderr_buf)
        return lines[-max(1, int(limit)):] if lines else []

    def is_alive(self) -> bool:
        """Return True if the underlying worker subprocess is currently running."""
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def status(self) -> dict:
        """Return a thread-safe snapshot of worker state."""
        with self._lock:
            alive = self._proc is not None and self._proc.poll() is None
            pid = self._proc.pid if alive and self._proc is not None else None
            idle_s = max(0.0, time.monotonic() - self.last_used) if alive and self.last_used else None
            return {
                "name": self.name,
                "script": str(self.script_path),
                "alive": alive,
                "pid": pid,
                "device": self.device,
                "starts": self.starts,
                "requests": self.requests,
                "idle_timeout_s": self.idle_timeout_s,
                "idle_s": round(idle_s, 2) if idle_s is not None else None,
            }

    def probe(self, timeout: float = 15.0) -> dict:
        """Run `<script> --probe` without starting `--serve` or triggering downloads."""
        proc_env = os.environ.copy()
        if self.env:
            proc_env.update(self.env)
        p = subprocess.run(
            [sys.executable, str(self.script_path), "--probe"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=proc_env,
            **_NO_WIN,
        )
        lines = [ln.strip() for ln in (p.stdout or "").splitlines() if ln.strip()]
        if lines:
            try:
                data = json.loads(lines[-1])
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError:
                pass
        if p.returncode != 0:
            err = (p.stderr or p.stdout or "").strip().splitlines()
            msg = err[-1][:300] if err else f"exit {p.returncode}"
            raise RuntimeError(f"{self.name} probe failed: {msg}")
        raise RuntimeError(f"{self.name} probe produced invalid output")

    def _drain_stderr(self, pipe) -> None:
        try:
            for line in pipe:
                text = line.rstrip("\r\n")
                with self._stderr_lock:
                    self._stderr_buf.append(text)
        except (OSError, ValueError):
            pass
        finally:
            try:
                pipe.close()
            except OSError:
                pass

    def _drain_stdout(self, pipe, out_q: queue.Queue[str | None]) -> None:
        try:
            for line in pipe:
                out_q.put(line)
        except (OSError, ValueError):
            pass
        finally:
            out_q.put(None)
            try:
                pipe.close()
            except OSError:
                pass

    def _terminate_proc_locked(self, graceful: bool = True) -> None:
        proc = self._proc
        self._proc = None
        self._stdout_queue = None
        if proc is None:
            return
        try:
            if graceful and proc.poll() is None and proc.stdin is not None:
                try:
                    proc.stdin.write(json.dumps({"cmd": "shutdown"}) + "\n")
                    proc.stdin.flush()
                    proc.wait(timeout=2.0)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2.0)
        except OSError:
            pass
        finally:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass

    def _read_json_line_locked(self, timeout: float, *, context: str) -> dict:
        out_q = self._stdout_queue
        proc = self._proc
        if out_q is None or proc is None:
            raise RuntimeError(f"{self.name} is not running ({context})")
        deadline = time.monotonic() + max(0.01, float(timeout))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._terminate_proc_locked(graceful=False)
                raise TimeoutError(f"{self.name} timed out after {timeout}s during {context}")
            try:
                raw = out_q.get(timeout=remaining)
            except queue.Empty as exc:
                self._terminate_proc_locked(graceful=False)
                raise TimeoutError(f"{self.name} timed out after {timeout}s during {context}") from exc
            if raw is None:
                rc = None
                try:
                    rc = proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass
                tail = "; ".join(self.stderr_tail(5))
                self._terminate_proc_locked(graceful=False)
                detail = f": {tail}" if tail else ""
                raise RuntimeError(f"{self.name} exited unexpectedly (code={rc}) during {context}{detail}")
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                self._terminate_proc_locked(graceful=False)
                raise RuntimeError(f"{self.name} emitted non-JSON line during {context}: {line[:200]}") from exc
            if not isinstance(obj, dict):
                self._terminate_proc_locked(graceful=False)
                raise RuntimeError(f"{self.name} emitted non-object JSON during {context}")
            return obj

    def _ensure_started_locked(self, timeout: float | None = None) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        if self._proc is not None:
            self._terminate_proc_locked(graceful=False)

        with self._stderr_lock:
            self._stderr_buf.clear()

        proc_env = os.environ.copy()
        proc_env.setdefault("PYTHONUNBUFFERED", "1")
        if self.env:
            proc_env.update(self.env)

        proc = subprocess.Popen(
            [sys.executable, str(self.script_path), "--serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=proc_env,
            **_NO_WIN,
        )
        out_q: queue.Queue[str | None] = queue.Queue()
        self._proc = proc
        self._stdout_queue = out_q
        self._stdout_thread = threading.Thread(
            target=self._drain_stdout, args=(proc.stdout, out_q), name=f"{self.name}-stdout", daemon=True
        )
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, args=(proc.stderr,), name=f"{self.name}-stderr", daemon=True
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

        ready_timeout = self.startup_timeout_s if timeout is None else float(timeout)
        ready = self._read_json_line_locked(ready_timeout, context="startup")
        if not ready.get("ready"):
            err = ready.get("error") or "worker failed to initialize"
            self._terminate_proc_locked(graceful=False)
            raise RuntimeError(f"{self.name} startup failed: {err}")
        self.device = ready.get("device")
        self.starts += 1
        self.last_used = time.monotonic()

    def run(self, payload: dict, timeout: float = 900.0) -> dict:
        """Send a JSONL request to the persistent worker, lazily starting or restarting if needed."""
        if not isinstance(payload, dict):
            raise TypeError("payload must be a dict")
        req_id = payload.get("id") or uuid.uuid4().hex[:12]
        req = {**payload, "id": req_id}

        with self._lock:
            self._ensure_started_locked(timeout=max(float(timeout), self.startup_timeout_s) if payload.get("cmd") != "ping" else float(timeout))
            proc = self._proc
            if proc is None or proc.stdin is None:
                raise RuntimeError(f"{self.name} stdin unavailable")
            try:
                proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
                proc.stdin.flush()
            except OSError:
                # Stale pipe between poll() and write(): restart once before sending.
                self._terminate_proc_locked(graceful=False)
                self._ensure_started_locked(timeout=float(timeout))
                proc = self._proc
                assert proc is not None and proc.stdin is not None
                proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
                proc.stdin.flush()

            deadline = time.monotonic() + max(0.01, float(timeout))
            while True:
                remaining = deadline - time.monotonic()
                resp = self._read_json_line_locked(remaining, context="request")
                if resp.get("id") not in (None, req_id):
                    continue
                self.last_used = time.monotonic()
                self.requests += 1
                if not resp.get("ok"):
                    raise RuntimeError(str(resp.get("error") or f"{self.name} request failed"))
                if "result" in resp and isinstance(resp["result"], dict):
                    return resp["result"]
                return resp

    def close(self) -> None:
        """Gracefully shut down the worker subprocess if running."""
        with self._lock:
            self._terminate_proc_locked(graceful=True)

    def close_if_idle(self, now: float | None = None) -> bool:
        """Close the worker if it has been idle for at least `idle_timeout_s`. Returns True if closed."""
        with self._lock:
            if self._proc is None:
                return False
            if self._proc.poll() is not None:
                self._terminate_proc_locked(graceful=False)
                return False
            if self.idle_timeout_s <= 0:
                return False
            cur = time.monotonic() if now is None else float(now)
            if cur - self.last_used >= self.idle_timeout_s:
                self._terminate_proc_locked(graceful=True)
                return True
            return False


class WorkerPool:
    """Pool managing persistent out-of-process diarization workers."""

    def __init__(self, idle_timeout_s: float = 300.0, root: Path | None = None) -> None:
        base = Path(root) if root is not None else Path(__file__).resolve().parent
        self.idle_timeout_s = float(idle_timeout_s)
        self._workers: dict[str, PersistentJsonlWorker] = {
            "pyannote": PersistentJsonlWorker("pyannote", base / "diarize_worker.py", idle_timeout_s=self.idle_timeout_s),
            "nemotron": PersistentJsonlWorker("nemotron", base / "diarize_nemotron.py", idle_timeout_s=self.idle_timeout_s),
        }

    def get(self, kind: str) -> PersistentJsonlWorker:
        if kind not in self._workers:
            raise ValueError(f"Unknown diarizer worker: {kind!r}")
        return self._workers[kind]

    def probe(self, kind: str, timeout: float = 15.0) -> dict:
        return self.get(kind).probe(timeout=timeout)

    def run_diarizer(self, kind: str, wav: str | Path, num_spk: int = 0, timeout: float = 900.0) -> dict:
        return self.get(kind).run({"wav": str(wav), "num_spk": int(num_spk or 0)}, timeout=timeout)

    def close_idle(self, now: float | None = None) -> list[str]:
        closed = []
        for name, worker in self._workers.items():
            if worker.close_if_idle(now=now):
                closed.append(name)
        return closed

    def close_all(self) -> None:
        for worker in self._workers.values():
            worker.close()

    def status(self) -> dict:
        return {name: worker.status() for name, worker in self._workers.items()}


_DEFAULT_POOL: WorkerPool | None = None
_DEFAULT_POOL_LOCK = threading.Lock()


def default_pool() -> WorkerPool:
    """Return the process-wide WorkerPool singleton, shutting down workers on exit."""
    global _DEFAULT_POOL
    with _DEFAULT_POOL_LOCK:
        if _DEFAULT_POOL is None:
            _DEFAULT_POOL = WorkerPool()
            atexit.register(_DEFAULT_POOL.close_all)
        return _DEFAULT_POOL
