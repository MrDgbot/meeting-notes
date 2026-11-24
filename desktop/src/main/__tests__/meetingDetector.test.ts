import { describe, expect, it, vi } from "vitest";
import { detectActiveMeetingApp, MeetingDetector, parseCoreAudioInputPids } from "../meetingDetector";

const SAMPLE_PMSET_IDLE = `2026-11-24 16:52:37 +0800 
Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 555(coreaudiod): [0x002afaa500019675] 00:01:41 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep"  
\tCreated for PID: 58274. 
\tResources: audio-in BuiltInMicrophoneDevice 
   pid 555(coreaudiod): [0x002afaa500019699] 00:02:10 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"  
\tCreated for PID: 70947. 
\tResources: audio-out BuiltInSpeakerDevice 
   pid 555(coreaudiod): [0x002afaa5000196aa] 00:00:06 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep"  
\tCreated for PID: 88888. 
\tResources: audio-in BuiltInMicrophoneDevice 
   pid 1300(UURemote): [0x0028a6c4000189a7] 42:50:37 PreventUserIdleSystemSleep named: "UURemote Disable Idle System Sleep"  
No kernel assertions.
`;

const SAMPLE_PS_IDLE = [
  " 1068 /usr/libexec/avconferenced",
  "15700 npm exec @larksuiteoapi/lark-mcp mcp -a test -l zh",
  "58274 /opt/meeting-notes/.venv/bin/ffmpeg",
  "62411 /Applications/Lark.app/Contents/Frameworks/Lark Framework.framework/Versions/147/Helpers/Lark Helper (Renderer).app/Contents/MacOS/Lark Helper (Renderer)",
  "70947 /Applications/Lark.app/Contents/MacOS/Feishu",
  "88888 /Applications/TencentMeeting.app/Contents/MacOS/TencentMeeting",
  "99900 /Applications/zoom.us.app/Contents/MacOS/zoom.us",
].join("\n");

describe("parseCoreAudioInputPids", () => {
  it("extracts only coreaudiod audio-in PIDs active for >= minDurationSec", () => {
    const pids = parseCoreAudioInputPids(SAMPLE_PMSET_IDLE, 10);
    expect(pids.has(58274)).toBe(true); // ffmpeg ambient holding mic for 01:41
    expect(pids.has(70947)).toBe(false); // audio-out playback only
    expect(pids.has(88888)).toBe(false); // audio-in for 6s (< 10s threshold)
    expect(pids.has(1300)).toBe(false); // non-coreaudiod assertion
  });
});

describe("detectActiveMeetingApp", () => {
  it("ignores idle background daemons, idle meeting apps, lark-mcp, audio-out, and our own ffmpeg", () => {
    expect(detectActiveMeetingApp(SAMPLE_PS_IDLE, SAMPLE_PMSET_IDLE, 1000)).toBeNull();
  });

  it("detects Zoom active call CptHost fallback even without audio-in", () => {
    const psActiveZoom = [
      SAMPLE_PS_IDLE,
      "99950 /Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost",
    ].join("\n");

    expect(detectActiveMeetingApp(psActiveZoom, SAMPLE_PMSET_IDLE, 1234)).toEqual({
      id: "zoom",
      name: "Zoom 会议",
      processName: "CptHost",
      detectedAt: 1234,
    });
  });

  it("detects Feishu, Tencent Meeting, FaceTime, Teams, WeCom, DingTalk when holding coreaudiod audio-in >= 10s", () => {
    const pmsetFor = (pid: number) =>
      `   pid 555(coreaudiod): [0x1] 00:00:15 PreventUserIdleSystemSleep named: "mic"  \n\tCreated for PID: ${pid}. \n\tResources: audio-in BuiltInMicrophoneDevice \n`;

    expect(detectActiveMeetingApp(SAMPLE_PS_IDLE, pmsetFor(62411), 200)?.id).toBe("feishu");
    expect(detectActiveMeetingApp(SAMPLE_PS_IDLE, pmsetFor(88888), 200)?.id).toBe("tencent");
    expect(detectActiveMeetingApp(SAMPLE_PS_IDLE, pmsetFor(1068), 200)?.id).toBe("facetime");
    expect(detectActiveMeetingApp(SAMPLE_PS_IDLE, pmsetFor(15700), 200)).toBeNull();

    const psMore = [
      "31000 /Applications/Microsoft Teams.app/Contents/MacOS/MSTeams",
      "32000 /Applications/企业微信.app/Contents/MacOS/WXWork",
      "33000 /Applications/DingTalk.app/Contents/MacOS/DingTalk",
    ].join("\n");
    expect(detectActiveMeetingApp(psMore, pmsetFor(31000), 200)?.id).toBe("teams");
    expect(detectActiveMeetingApp(psMore, pmsetFor(32000), 200)?.id).toBe("wecom");
    expect(detectActiveMeetingApp(psMore, pmsetFor(33000), 200)?.id).toBe("dingtalk");
  });
});

describe("MeetingDetector lifecycle and cooldowns", () => {
  it("notifies once on transition, clears when call ends, and respects 30-min dismiss cooldown", async () => {
    let clock = 10_000;
    let psStdout = SAMPLE_PS_IDLE;
    let pmsetStdout =
      '   pid 555(coreaudiod): [0x1] 00:00:25 PreventUserIdleSystemSleep named: "mic"\n\tCreated for PID: 70947.\n\tResources: audio-in BuiltInMicrophoneDevice\n';
    let recording = false;

    const onDetected = vi.fn();
    const onNotify = vi.fn();

    const detector = new MeetingDetector({
      platform: "darwin",
      cooldownMs: 30 * 60_000,
      now: () => clock,
      getRecorderState: () => ({
        active: recording,
        paused: false,
        mid: null,
        elapsedMs: 0,
        updatedAt: clock,
      }),
      runPs: async () => psStdout,
      runPmset: async () => pmsetStdout,
      onDetected,
      onNotify,
    });

    const first = await detector.pollOnce();
    expect(first?.id).toBe("feishu");
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledTimes(1);

    // Polling again keeps banner active without duplicate notifications
    clock += 15_000;
    await detector.pollOnce();
    expect(detector.getCurrent()?.id).toBe("feishu");
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledTimes(1);

    // Dismiss hides banner & suppresses the entire continuous call even past 30 minutes
    detector.dismiss("feishu");
    expect(detector.getCurrent()).toBeNull();
    expect(onDetected).toHaveBeenLastCalledWith(null);

    clock += 5 * 60_000;
    await detector.pollOnce();
    expect(detector.getCurrent()).toBeNull();

    clock += 26 * 60_000;
    await detector.pollOnce();
    expect(detector.getCurrent()).toBeNull();

    // Brief absence (< 60s) does not reset the dismissed session
    pmsetStdout = SAMPLE_PMSET_IDLE;
    await detector.pollOnce();
    clock += 30_000;
    await detector.pollOnce();
    pmsetStdout =
      '   pid 555(coreaudiod): [0x1] 00:00:25 PreventUserIdleSystemSleep named: "mic"\n\tCreated for PID: 70947.\n\tResources: audio-in BuiltInMicrophoneDevice\n';
    await detector.pollOnce();
    expect(detector.getCurrent()).toBeNull();

    // Once the call truly ends (absent >= 60s), a subsequent new call re-detects
    pmsetStdout = SAMPLE_PMSET_IDLE;
    await detector.pollOnce();
    clock += 65_000;
    await detector.pollOnce();
    pmsetStdout =
      '   pid 555(coreaudiod): [0x1] 00:00:25 PreventUserIdleSystemSleep named: "mic"\n\tCreated for PID: 70947.\n\tResources: audio-in BuiltInMicrophoneDevice\n';
    const reappeared = await detector.pollOnce();
    expect(reappeared?.id).toBe("feishu");
    expect(onNotify).toHaveBeenCalledTimes(2);

    // Starting manual recording clears the active prompt
    recording = true;
    await detector.pollOnce();
    expect(detector.getCurrent()).toBeNull();

    // Ending recording when call has ended remains clear
    recording = false;
    pmsetStdout = SAMPLE_PMSET_IDLE;
    psStdout = SAMPLE_PS_IDLE;
    await detector.pollOnce();
    expect(detector.getCurrent()).toBeNull();
  });
});
