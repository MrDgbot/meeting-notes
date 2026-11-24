----------------------- MODULE MeetingLifecycleBugReplay -----------------------
\* Replays two real historical concurrency bugs from git history to prove TLC catches them:
\* 1. Commit 3ef2187: missing _inflight dedup allows duplicate transcribe enqueue (breaks NoDoubleTranscribe).
\* 2. docs/state-machines.md #2: missing _run_gen check allows an unwinding capture thread after stop->start
\*    to overwrite the restarted ambient loop back to "off" (breaks AmbientStateMatchesEnabled).
EXTENDS Naturals

CONSTANTS MaxRecs, MaxAmbGen

VARIABLES
    status, livePhase, liveRec, holdHeld, inflight, queueCount,
    ambEnabled, ambState, ambGen, staleAmbGen

vars == <<status, livePhase, liveRec, holdHeld, inflight, queueCount,
          ambEnabled, ambState, ambGen, staleAmbGen>>

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

LiveStart ==
    /\ livePhase = "none"
    /\ status \in {"new", "ready", "error"}
    /\ liveRec < MaxRecs
    /\ livePhase' = "recording"
    /\ liveRec' = liveRec + 1
    /\ holdHeld' = TRUE
    /\ status' = "recording"
    /\ ambState' = IF ambEnabled THEN "held" ELSE ambState
    /\ UNCHANGED <<inflight, queueCount, ambEnabled, ambGen, staleAmbGen>>

LiveFinalizeQueue ==
    /\ livePhase \in {"recording", "reconnecting"}
    /\ livePhase' = "none"
    /\ holdHeld' = FALSE
    /\ status' = "queued"
    /\ queueCount < 2
    /\ queueCount' = queueCount + 1
    /\ inflight' = TRUE
    /\ ambState' = IF ambEnabled THEN "listening" ELSE ambState
    /\ UNCHANGED <<liveRec, ambEnabled, ambGen, staleAmbGen>>

\* Historical bug (pre-3ef2187): retranscribe / stuck-watch enqueues without checking _inflight
BuggyDuplicateEnqueue ==
    /\ livePhase = "none"
    /\ status \in {"queued", "ready", "error"}
    /\ queueCount < 2
    /\ status' = "queued"
    /\ queueCount' = queueCount + 1
    /\ inflight' = TRUE
    /\ UNCHANGED <<livePhase, liveRec, holdHeld, ambEnabled, ambState, ambGen, staleAmbGen>>

AmbientStart ==
    /\ ~ambEnabled
    /\ ambGen < MaxAmbGen
    /\ ambEnabled' = TRUE
    /\ ambGen' = ambGen + 1
    /\ ambState' = IF holdHeld THEN "held" ELSE "listening"
    /\ UNCHANGED <<status, livePhase, liveRec, holdHeld, inflight, queueCount, staleAmbGen>>

AmbientStop ==
    /\ ambEnabled
    /\ staleAmbGen = 0
    /\ ambEnabled' = FALSE
    /\ staleAmbGen' = ambGen
    /\ UNCHANGED <<status, livePhase, liveRec, holdHeld, inflight, queueCount, ambState, ambGen>>

\* Historical bug (pre-Step 1): exiting thread unconditionally writes OFF without checking _run_gen
BuggyAmbientThreadExit ==
    /\ staleAmbGen > 0
    /\ staleAmbGen' = 0
    /\ ambState' = "off"
    /\ UNCHANGED <<status, livePhase, liveRec, holdHeld, inflight, queueCount, ambEnabled, ambGen>>

Next ==
    \/ LiveStart
    \/ LiveFinalizeQueue
    \/ BuggyDuplicateEnqueue
    \/ AmbientStart
    \/ AmbientStop
    \/ BuggyAmbientThreadExit

Spec == Init /\ [][Next]_vars

NoDoubleTranscribe == queueCount <= 1
AmbientStateMatchesEnabled == (ambEnabled /\ ~holdHeld) => (ambState = "listening")

===============================================================================
