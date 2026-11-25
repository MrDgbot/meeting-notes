import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.0",
    isPackaged: false,
    getAppPath: () => "/tmp",
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      on: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  },
}));

import { compareSemver, normalizeReleaseNotes, parseGithubReleaseFallback } from "../updater";

describe("updater helpers", () => {
  it("compares semantic versions with v prefixes and prereleases cleanly", () => {
    expect(compareSemver("v0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "v0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
    expect(compareSemver("0.2.0", "0.2.0-beta.1")).toBe(1);
    expect(compareSemver("0.2.0-beta.1", "0.2.0-beta.2")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  it("normalizes string and structured release notes", () => {
    expect(normalizeReleaseNotes("<p>新增：自动更新<br/>修复问题</p>")).toBe("新增：自动更新\n修复问题");
    expect(
      normalizeReleaseNotes([
        { version: "0.2.0", note: "<h3>✨ 新功能</h3><p>支持自动更新</p>" },
        { version: "0.1.5", note: "修复图标" },
      ]),
    ).toBe("✨ 新功能\n支持自动更新\n\n修复图标");
  });

  it("parses GitHub release JSON fallback and ignores drafts", () => {
    expect(parseGithubReleaseFallback({ draft: true, tag_name: "v0.9.0" }, "0.1.0")).toBeNull();

    const newer = parseGithubReleaseFallback(
      {
        tag_name: "v0.2.0",
        name: "Meeting Notes v0.2.0",
        published_at: "2026-12-01T10:00:00Z",
        body: "## 更新内容\n- 自动更新",
        html_url: "https://github.com/MrDgbot/meeting-notes/releases/tag/v0.2.0",
      },
      "0.1.0",
    );
    expect(newer?.hasUpdate).toBe(true);
    expect(newer?.info.version).toBe("0.2.0");
    expect(newer?.info.releaseNotes).toContain("自动更新");

    const same = parseGithubReleaseFallback({ tag_name: "v0.1.0", body: "init" }, "0.1.0");
    expect(same?.hasUpdate).toBe(false);
  });
});
