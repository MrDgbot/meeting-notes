export const title = "Meeting Lifecycle, LiveRec, Transcribe Queue & Ambient Stop/Start";

export const state = (v) => ({
  Meeting: `${v.status}${v.queueCount > 1 ? " (DOUBLE-QUEUED!)" : ""}`,
  Live: v.livePhase === "none" ? "idle" : `${v.livePhase}#${v.liveRec}`,
  Ambient: `${v.ambEnabled ? "on" : "off"}:${v.ambState}${v.staleAmbGen > 0 ? " (unwinding)" : ""}`,
});

export const step = (action) => ({
  LiveStart: "browser starts live mic",
  LiveHandshakeRollback: "handshake drops (rolled back)",
  LiveDetach: "websocket drops (grace window)",
  LiveResume: "same rec reconnects",
  LiveTakeover: "new rec takes over",
  LiveFinalizeQueue: "recording ends -> queue transcribe",
  LiveFinalizeShort: "recording too short (<1s)",
  RetranscribeOrStuckQueue: "retranscribe / stuck-watch queues",
  DuplicateQueueAttempt: null,
  TranscribeStart: "worker starts transcribing",
  TranscribeFinish: "transcribe succeeds",
  TranscribeFail: "transcribe fails",
  AmbientStart: "ambient start",
  AmbientStop: "ambient stop",
  AmbientThreadExit: "old ambient thread exits",
}[action] ?? action);
