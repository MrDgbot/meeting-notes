import { create } from "zustand";
import { RecorderEngine, type RecorderSnapshot } from "@/lib/recorder";
import { useAppStore } from "./appStore";

interface RecorderStoreState extends RecorderSnapshot {
  prime: () => void;
  start: (mid: string, source: "mic" | "mix") => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<{ lost: number; timeout?: boolean; gaveUp?: boolean }>;
  reconnectDevice: () => Promise<void>;
  giveUp: () => void;
  setBeforeRemoteEnd: (fn: (() => Promise<void>) | undefined) => void;
}

let beforeRemoteEndFn: (() => Promise<void>) | undefined;

const INITIAL_SNAPSHOT: RecorderSnapshot = {
  active: false,
  paused: false,
  stopping: false,
  mid: null,
  elapsedMs: 0,
  pendingSec: 0,
  level: 0,
  conn: "ok",
  channels: 1,
  lost: null,
  stall: null,
  finals: [],
  partial: null,
  gaps: [],
};

let engineRef: RecorderEngine | null = null;

export function getRecorderEngine(): RecorderEngine {
  if (!engineRef) {
    engineRef = new RecorderEngine({
      onSnapshot: (snap) => {
        useRecorderStore.setState(snap);
      },
      onToast: (msg, ms) => {
        useAppStore.getState().pushToast(msg, ms);
      },
      onClosed: () => {
        void useAppStore.getState().loadMeetings();
        window.dispatchEvent(new CustomEvent("mn:recorder-closed"));
      },
      onBeforeRemoteEnd: async () => {
        await beforeRemoteEndFn?.();
      },
    });
  }
  return engineRef;
}

export const useRecorderStore = create<RecorderStoreState>(() => ({
  ...INITIAL_SNAPSHOT,
  prime: () => getRecorderEngine().prime(),
  start: async (mid, source) => {
    await getRecorderEngine().start(mid, source);
  },
  pause: () => getRecorderEngine().pause(),
  resume: () => getRecorderEngine().resume(),
  stop: () => getRecorderEngine().stop(),
  reconnectDevice: () => getRecorderEngine().reconnectDevice(),
  giveUp: () => getRecorderEngine().giveUp(),
  setBeforeRemoteEnd: (fn) => {
    beforeRemoteEndFn = fn;
  },
}));
