import { describe, expect, it } from "vitest";
import { asrInfo, buildSpeakerMap, COLORS, computeRecHealth, fmtDur, fmtTs, wallOf } from "../format";
import type { MeetingDetail } from "../types";

describe("shared formatting & domain helpers", () => {
  it("formats timestamps and durations concisely", () => {
    expect(fmtTs(0)).toBe("00:00");
    expect(fmtTs(65_000)).toBe("01:05");
    expect(fmtTs(3_661_000)).toBe("1:01:01");
    expect(fmtDur(42)).toBe("42秒");
    expect(fmtDur(125)).toBe("2分5秒");
    expect(fmtDur(3720)).toBe("1小时2分");
  });

  it("maps dual-channel and merged speaker names to consistent palette colors", () => {
    const detail = {
      meta: {
        id: "m1",
        title: "t",
        created: "2026-11-23T10:00:00",
        status: "ready",
        source: "mic",
        duration: 30,
        num_spk: 2,
        hotword: "",
        template: "general",
        speakers: { "0": "张三", "1": "张三", "2": "李四" },
        error: "",
      },
      transcript: {
        paragraphs: [
          { start: 0, end: 5000, spk: 0, text: "a" },
          { start: 5000, end: 9000, spk: 1, text: "b" },
          { start: 9000, end: 12000, spk: 2, text: "c" },
        ],
      },
      live: [],
      segmap: null,
      skips: [],
      minutes: null,
      marks: [],
      minutes_stale: [],
      suspects: [],
      notes: "",
      qa: [],
      has_audio: true,
      live_active: false,
      live_state: null,
      ambient_active: false,
    } satisfies MeetingDetail;

    const map = buildSpeakerMap(detail);
    expect(map.spkName(0)).toBe("张三");
    expect(map.spkName(2)).toBe("李四");
    expect(map.spkColor(0)).toBe(map.spkColor(1));
    expect(map.spkColor(2)).toBe(COLORS[1]);
  });

  it("binary searches wall clock segmap and aggregates rec_health gaps", () => {
    const segs: [number, number][] = [
      [0, 1000],
      [10_000, 1050],
    ];
    expect(wallOf(12_500, segs)).toBe(1052.5);
    expect(asrInfo({ engine: "doubao", units: 10, local: 2, failed: 1 })).toContain("本机补 2 段");

    const rh = computeRecHealth({
      id: "m2",
      title: "t",
      created: "2026-11-23T10:00:00",
      status: "ready",
      source: "mic",
      duration: 60,
      num_spk: 1,
      hotword: "",
      template: "general",
      speakers: {},
      error: "",
      audio_channels: 1,
      rec_health: [{ rec: "r1", reconnects: 2, gaps: [{ at_ms: 5000, dur_ms: 4000, reason: "hidden" }] }],
    });
    expect(rh?.hasIssue).toBe(true);
    expect(rh?.reconnects).toBe(2);
    expect(rh?.summaryText).toContain("1 处缺口");
  });
});
