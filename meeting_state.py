import logging
import threading
import time
from collections import deque

import store
from store import MeetingStatus

log = logging.getLogger("meeting_state")

NEW: MeetingStatus = "new"
RECORDING: MeetingStatus = "recording"
QUEUED: MeetingStatus = "queued"
TRANSCRIBING: MeetingStatus = "transcribing"
READY: MeetingStatus = "ready"
ERROR: MeetingStatus = "error"

STATES: tuple[MeetingStatus, ...] = (NEW, RECORDING, QUEUED, TRANSCRIBING, READY, ERROR)
BUSY: frozenset[MeetingStatus] = frozenset((QUEUED, TRANSCRIBING))
ACTIVE: frozenset[MeetingStatus] = frozenset((RECORDING, QUEUED, TRANSCRIBING))

TRANSITIONS: dict[MeetingStatus, frozenset[MeetingStatus]] = {
    NEW: frozenset((RECORDING, QUEUED, READY, NEW)),
    RECORDING: frozenset((RECORDING, QUEUED, READY, NEW)),
    QUEUED: frozenset((TRANSCRIBING, ERROR, QUEUED, NEW)),
    TRANSCRIBING: frozenset((READY, ERROR, QUEUED, NEW)),
    READY: frozenset((QUEUED, RECORDING, READY)),
    ERROR: frozenset((QUEUED, RECORDING, ERROR, NEW)),
}

_hist: deque[dict] = deque(maxlen=200)
_illegal = 0
_lock = threading.Lock()


def _as_status(value: str | None) -> MeetingStatus | None:
    cand = value or NEW
    for s in STATES:
        if s == cand:
            return s
    return None


def allowed(frm: str | None, to: str) -> bool:
    src = _as_status(frm)
    return src is not None and to in TRANSITIONS[src]


def transition(mid: str, to: MeetingStatus, *, reason: str = "", **fields) -> dict:
    global _illegal
    if to not in STATES:
        log.warning("meeting %s: unknown status %r (reason=%s), writing anyway", mid, to, reason)
    with store.locked():
        cur = store.get(mid)
        if cur is None:
            raise KeyError(mid)
        frm = cur.get("status") or NEW
        ok = allowed(frm, to)
        meta = store.update(mid, status=to, **fields)
    with _lock:
        if not ok:
            _illegal += 1
        _hist.append({"t": round(time.time(), 3), "id": mid, "from": frm, "to": to, "reason": reason, "ok": ok})
    if not ok:
        log.warning("meeting %s: unexpected status change %s -> %s (reason=%s)", mid, frm, to, reason)
    return meta


def history(limit: int = 50) -> list[dict]:
    with _lock:
        return list(_hist)[-limit:]


def illegal_count() -> int:
    return _illegal


def schema() -> dict:
    return {"states": list(STATES), "transitions": {k: sorted(v) for k, v in TRANSITIONS.items()},
            "busy": list(BUSY), "active": list(ACTIVE)}
