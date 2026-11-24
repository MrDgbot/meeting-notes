--------------------------- MODULE MeetingLifecycle ---------------------------
EXTENDS Naturals

CONSTANTS MaxRecs, MaxAmbGen

VARIABLES
    status,        \* meta.json["status"]: "new","recording","queued","transcribing","ready","error"
    livePhase,     \* LIVE[mid] phase: "none","recording","reconnecting"
    liveRec,       \* active LiveRec.rec id (0 = none)
    holdHeld,      \* mid \in ambient.holds
    inflight,      \* mid \in app._inflight
    queueCount,    \* count of pending/running transcribe jobs for mid in app.jobs
    ambEnabled,    \* ambient.enabled
    ambState,      \* ambient.state: "off","listening","held"
    ambGen,        \* ambient._run_gen (current generation)
    staleAmbGen    \* an older capture thread still unwinding after stop() (0 = none)

vars == <<status, livePhase, liveRec, holdHeld, inflight, queueCount,
          ambEnabled, ambState, ambGen, staleAmbGen>>

TypeOK ==
    /\ status \in {"new", "recording", "queued", "transcribing", "ready", "error"}
    /\ livePhase \in {"none", "recording", "reconnecting"}
    /\ liveRec \in 0..MaxRecs
    /\ holdHeld \in BOOLEAN
    /\ inflight \in BOOLEAN
    /\ queueCount \in 0..2
    /\ ambEnabled \in BOOLEAN
    /\ ambState \in {"off", "listening", "held"}
    /\ ambGen \in 0..MaxAmbGen
    /\ staleAmbGen \in 0..MaxAmbGen

Init ==
    /\ status = "new"
    /\ livePhase = "none"
    /\ liveRec = 0
    /\ holdHeld = FALSE
    /\ inflight = FALSE
    /\ queueCount = 0
    /\ ambEnabled = FALSE
    /\ ambState = "off"
    /\ ambGen = 0
    /\ staleAmbGen = 0

\* 1. ws_live starts a new live recording (guarded by _live_lock and status \notin BUSY)
LiveStart ==
    /\ livePhase = "none"
    /\ status \in {"new", "ready", "error"}
    /\ ~inflight
    /\ liveRec < MaxRecs
    /\ livePhase' = "recording"
    /\ liveRec' = liveRec + 1
    /\ holdHeld' = TRUE
    /\ status' = "recording"
    /\ ambState' = IF ambEnabled THEN "held" ELSE ambState
    /\ UNCHANGED <<inflight, queueCount, ambEnabled, ambGen, staleAmbGen>>

\* 2. ws_live disconnects mid-handshake while sending ready -> full rollback (commit 04f1bf6)
LiveHandshakeRollback ==
    /\ livePhase = "none"
    /\ status \in {"new", "ready", "error"}
    /\ ~inflight
    /\ UNCHANGED vars

\* 3. WebSocket drops -> _live_detach moves LiveRec to reconnecting grace window
LiveDetach ==
    /\ livePhase = "recording"
    /\ livePhase' = "reconnecting"
    /\ UNCHANGED <<status, liveRec, holdHeld, inflight, queueCount,
                   ambEnabled, ambState, ambGen, staleAmbGen>>

\* 4. Same rec reconnects within LIVE_GRACE_S
LiveResume ==
    /\ livePhase = "reconnecting"
    /\ livePhase' = "recording"
    /\ UNCHANGED <<status, liveRec, holdHeld, inflight, queueCount,
                   ambEnabled, ambState, ambGen, staleAmbGen>>

\* 5. Different rec takes over a reconnecting LiveRec under _live_lock (queue=False)
LiveTakeover ==
    /\ livePhase = "reconnecting"
    /\ liveRec < MaxRecs
    /\ livePhase' = "recording"
    /\ liveRec' = liveRec + 1
    /\ holdHeld' = TRUE
    /\ status' = "recording"
    /\ UNCHANGED <<inflight, queueCount, ambEnabled, ambState, ambGen, staleAmbGen>>

\* 6. _live_finalize (stop / grace timeout / live_end) releases LIVE + hold and queues transcribe once
LiveFinalizeQueue ==
    /\ livePhase \in {"recording", "reconnecting"}
    /\ livePhase' = "none"
    /\ holdHeld' = FALSE
    /\ status' = "queued"
    /\ ambState' = IF ambEnabled THEN "listening" ELSE ambState
    /\ IF ~inflight
          THEN /\ inflight' = TRUE
               /\ queueCount' = queueCount + 1
          ELSE UNCHANGED <<inflight, queueCount>>
    /\ UNCHANGED <<liveRec, ambEnabled, ambGen, staleAmbGen>>

\* 7. _live_finalize for too-short audio (<1s) skips queue and lands in new/ready
LiveFinalizeShort ==
    /\ livePhase \in {"recording", "reconnecting"}
    /\ livePhase' = "none"
    /\ holdHeld' = FALSE
    /\ status' = "new"
    /\ ambState' = IF ambEnabled THEN "listening" ELSE ambState
    /\ UNCHANGED <<liveRec, inflight, queueCount, ambEnabled, ambGen, staleAmbGen>>

\* 8. Retranscribe or stuck-watch triggers queue_transcribe (deduped by _inflight, commit 3ef2187)
RetranscribeOrStuckQueue ==
    /\ livePhase = "none"
    /\ status \in {"ready", "error"}
    /\ ~inflight
    /\ status' = "queued"
    /\ inflight' = TRUE
    /\ queueCount' = queueCount + 1
    /\ UNCHANGED <<livePhase, liveRec, holdHeld, ambEnabled, ambState, ambGen, staleAmbGen>>

\* 9. Duplicate queue_transcribe call while already inflight is a no-op
DuplicateQueueAttempt ==
    /\ inflight
    /\ UNCHANGED vars

\* 10. Transcribe worker pops queued job -> transcribing
TranscribeStart ==
    /\ status = "queued"
    /\ queueCount > 0
    /\ status' = "transcribing"
    /\ UNCHANGED <<livePhase, liveRec, holdHeld, inflight, queueCount,
                   ambEnabled, ambState, ambGen, staleAmbGen>>

\* 11. Transcribe worker finishes -> ready, releases _inflight
TranscribeFinish ==
    /\ status = "transcribing"
    /\ queueCount > 0
    /\ status' = "ready"
    /\ queueCount' = queueCount - 1
    /\ inflight' = (queueCount - 1 > 0)
    /\ UNCHANGED <<livePhase, liveRec, holdHeld, ambEnabled, ambState, ambGen, staleAmbGen>>

\* 12. Transcribe worker errors -> error, releases _inflight so retry is possible
TranscribeFail ==
    /\ status \in {"queued", "transcribing"}
    /\ queueCount > 0
    /\ status' = "error"
    /\ queueCount' = queueCount - 1
    /\ inflight' = (queueCount - 1 > 0)
    /\ UNCHANGED <<livePhase, liveRec, holdHeld, ambEnabled, ambState, ambGen, staleAmbGen>>

\* 13. Ambient.start() increments _run_gen and starts a fresh capture thread
AmbientStart ==
    /\ ~ambEnabled
    /\ ambGen < MaxAmbGen
    /\ ambEnabled' = TRUE
    /\ ambGen' = ambGen + 1
    /\ ambState' = IF holdHeld THEN "held" ELSE "listening"
    /\ UNCHANGED <<status, livePhase, liveRec, holdHeld, inflight, queueCount, staleAmbGen>>

\* 14. Ambient.stop() disables ambient; capture thread may still be unwinding (staleAmbGen = ambGen)
AmbientStop ==
    /\ ambEnabled
    /\ staleAmbGen = 0
    /\ ambEnabled' = FALSE
    /\ staleAmbGen' = ambGen
    /\ UNCHANGED <<status, livePhase, liveRec, holdHeld, inflight, queueCount, ambState, ambGen>>

\* 15. Unwinding capture thread finishes exit: ONLY writes OFF if its gen == _run_gen (Step 1 fix)
AmbientThreadExit ==
    /\ staleAmbGen > 0
    /\ staleAmbGen' = 0
    /\ ambState' = IF staleAmbGen = ambGen /\ ~ambEnabled THEN "off" ELSE ambState
    /\ UNCHANGED <<status, livePhase, liveRec, holdHeld, inflight, queueCount, ambEnabled, ambGen>>

Next ==
    \/ LiveStart
    \/ LiveHandshakeRollback
    \/ LiveDetach
    \/ LiveResume
    \/ LiveTakeover
    \/ LiveFinalizeQueue
    \/ LiveFinalizeShort
    \/ RetranscribeOrStuckQueue
    \/ DuplicateQueueAttempt
    \/ TranscribeStart
    \/ TranscribeFinish
    \/ TranscribeFail
    \/ AmbientStart
    \/ AmbientStop
    \/ AmbientThreadExit

Spec == Init /\ [][Next]_vars

\* ---------------- Safety Invariants ----------------

\* Past bug 3ef2187: concurrent retranscribe/finalize/stuck-watch must never double-enqueue transcription
NoDoubleTranscribe == queueCount <= 1

\* Past bug 04f1bf6: LIVE session and ambient.holds must stay in exact 1-to-1 correspondence
LiveHoldConsistent == (livePhase # "none") <=> holdHeld

\* A meeting cannot simultaneously hold an active LiveRec and be queued/transcribing
NoRecordingWhileBusy == ~((livePhase # "none") /\ (status \in {"queued", "transcribing"}))

\* _inflight must match actual pending/running queue count so retries never deadlock or duplicate
InflightMatchesQueue == inflight <=> (queueCount > 0)

\* Past bug docs/state-machines.md #2: stale capture thread after stop->start must never clobber new run to off
AmbientStateMatchesEnabled == (ambEnabled /\ ~holdHeld) => (ambState = "listening")

\* When ambient is enabled and live mic holds it, ambient must stay held (never listening concurrently)
AmbientHeldDuringLive == (ambEnabled /\ holdHeld) => (ambState = "held")

===============================================================================
