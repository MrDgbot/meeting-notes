---
name: verify-meeting-lifecycle
description: "Formally verify the meeting lifecycle, LiveRec grace/takeover, transcribe queue deduplication, and Ambient stop/start generation invariants with TLA+ TLC. Use whenever modifying meeting_state.py, app.py live/transcribe lifecycle functions, or ambient.py start/stop/_loop."
---

# Verify meeting lifecycle concurrency invariants

## When this skill applies

Run this check before committing any edit to the covered files and functions below:

- `meeting_state.py`: `STATES`, `TRANSITIONS`, `transition()`
- `app.py`: `is_live_active()`, `queue_transcribe()`, `run_transcribe()`, `retranscribe()`, `_live_finalize()`, `_live_detach()`, `_live_expire()`, `ws_live()`
- `ambient.py`: `Ambient.start()`, `Ambient.stop()`, `Ambient._loop()`, `Ambient._set_state()`, `Ambient.hold()`, `Ambient.release()`

Sync commit: `a1ce503` (update this hash only after confirming `formal/MeetingLifecycle.tla` still matches the code at HEAD).

## What the model verifies

Bounds: `MaxRecs = 2`, `MaxAmbGen = 2`, single unwinding stale thread (`staleAmbGen = 0` before next stop), 148 reachable states, 558 transitions.

Properties checked exhaustively across every interleaving:

1. `NoDoubleTranscribe`: at most one transcribe job is queued or running for a meeting (`queueCount <= 1`). Harm prevented: duplicate GPU transcription and overwritten transcript files (commit `3ef2187`).
2. `LiveHoldConsistent`: an active `LIVE[mid]` session exists if and only if `ambient.holds` contains `mid`. Harm prevented: leaked holds keeping all-day recording permanently paused (commit `04f1bf6`).
3. `NoRecordingWhileBusy`: a meeting cannot have an active `LIVE[mid]` session while its status is `queued` or `transcribing`. Harm prevented: concurrent PCM appends racing offline transcription.
4. `InflightMatchesQueue`: `app._inflight` tracks every pending/running transcribe job and clears on completion or failure. Harm prevented: permanently stuck meetings that ignore retries.
5. `AmbientStateMatchesEnabled`: in the 3-state abstraction (`off` / `listening` / `held`), when `ambient.enabled` is true and no live mic hold is active, `ambient.state` stays `listening` (not overwritten back to `off` by an unwinding thread). Harm prevented: stale capture thread after `stop -> start` clobbering the restarted loop (`docs/state-machines.md`).
6. `AmbientHeldDuringLive`: when both `ambient.enabled` and a live mic hold are active, `ambient.state` is `held`. Harm prevented: recording the same speech twice.
7. `NoDeadlock`: no reachable state gets stuck with zero outgoing transitions.

Model assumptions and scope limits (do not overread beyond these bounds):
- `ws_live` checks both `status in BUSY` and `_is_transcribe_inflight(mid)`, and `LiveTakeover` transfers `ambient.hold` directly via `_live_finalize(..., release_hold=False)` without releasing between sessions.
- `ambState` collapses Ambient's 7 runtime states (`off`, `starting`, `listening`, `speech`, `paused`, `held`, `error`) into 3 states (`off`, `listening`, `held`) and applies holds synchronously (the real loop polls holds within ~0.5s).
- Not covered: disk I/O crashes mid-rename (covered by `store._atomic_write`), WebSocket frame framing, multi-stale-thread chains, and ASR model accuracy.

## How to run

Run the fast CI check (verifies the fixed model passes and the historical bug-replay model fails):

```bash
bash scripts/check_formal.sh
```

To inspect counterexamples and render a Mermaid statechart, read the result with the pstack `/statechart` skill on `formal/MeetingLifecycle.tla` with `--config formal/MeetingLifecycle.cfg --view formal/MeetingLifecycle.view.mjs`.

## Interpreting failures and updating the model

1. If `MeetingLifecycle.tla` fails an invariant, trace the shortest path in `/statechart` back to the Python function named above.
2. Reproduce the path in `tests/test_lifecycle_e2e.py` before fixing product code.
3. Never weaken an invariant to make TLC pass. Update `formal/MeetingLifecycle.tla` only when an intended behavior change alters the code's actual transitions, confirm `formal/MeetingLifecycleBugReplay.tla` still catches its regression, and then advance the sync commit above.
