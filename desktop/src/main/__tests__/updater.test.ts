import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.0",
    isPackaged: false,
    getAppPath: () => "/tmp",
    getPath: (name: string) => `/tmp/${name}`,
    quit: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
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

import {
  compareSemver,
  isAllowedDownloadUrl,
  normalizeReleaseNotes,
  parseGithubReleaseFallback,
  parseSha256Sums,
  resolveMacAppBundlePath,
  selectReleaseAsset,
} from "../updater";

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

  it("resolves macOS .app bundle path from execPath or appPath", () => {
    const exists = (p: string) => p === "/Applications/Meeting Notes.app/Contents/Info.plist";
    expect(
      resolveMacAppBundlePath(
        "/Applications/Meeting Notes.app/Contents/MacOS/Meeting Notes",
        "/Applications/Meeting Notes.app/Contents/Resources/app.asar",
        exists,
      ),
    ).toBe("/Applications/Meeting Notes.app");

    expect(resolveMacAppBundlePath("/usr/local/bin/electron", "/tmp/workspace", exists)).toBeNull();
  });

  it("validates allowed GitHub download URLs", () => {
    expect(
      isAllowedDownloadUrl(
        "https://github.com/MrDgbot/meeting-notes/releases/download/v0.1.1/Meeting-Notes-0.1.1-arm64-mac.zip",
      ),
    ).toBe(true);
    expect(
      isAllowedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/123"),
    ).toBe(true);
    expect(isAllowedDownloadUrl("http://github.com/MrDgbot/meeting-notes")).toBe(false);
    expect(isAllowedDownloadUrl("https://evil.example.com/update.zip")).toBe(false);
  });

  it("parses SHA256SUMS.txt ignoring path prefixes and binary asterisks", () => {
    const sums = parseSha256Sums(
      [
        `${"a".repeat(64)}  Meeting-Notes-0.1.1-arm64-mac.zip`,
        `${"B".repeat(64)} *./dist/Meeting-Notes-Setup-0.1.1.exe`,
        "invalid-line",
      ].join("\n"),
    );
    expect(sums.get("Meeting-Notes-0.1.1-arm64-mac.zip")).toBe("a".repeat(64));
    expect(sums.get("Meeting-Notes-Setup-0.1.1.exe")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  it("selects platform/arch release assets and filters metadata files", () => {
    const base = "https://github.com/MrDgbot/meeting-notes/releases/download/v0.1.1";
    const assets = [
      { name: "latest-mac.yml", browser_download_url: `${base}/latest-mac.yml` },
      { name: "Meeting-Notes-0.1.1-arm64-mac.zip.blockmap", browser_download_url: `${base}/arm64.blockmap` },
      { name: "Meeting-Notes-0.1.1-arm64-mac.zip", browser_download_url: `${base}/arm64-mac.zip` },
      { name: "Meeting-Notes-0.1.1-arm64.dmg", browser_download_url: `${base}/arm64.dmg` },
      { name: "Meeting-Notes-0.1.1-x64-mac.zip", browser_download_url: `${base}/x64-mac.zip` },
      { name: "Meeting-Notes-0.1.1-x64.dmg", browser_download_url: `${base}/x64.dmg` },
      { name: "Meeting-Notes-Setup-0.1.1.exe", browser_download_url: `${base}/Setup.exe` },
      { name: "Meeting-Notes-0.1.1-x86_64.AppImage", browser_download_url: `${base}/x86_64.AppImage` },
      { name: "meeting-notes_0.1.1_amd64.deb", browser_download_url: `${base}/amd64.deb` },
    ];

    expect(selectReleaseAsset(assets, "darwin", "arm64", "mac-zip")).toEqual({
      asset: assets[2],
      resolvedMode: "mac-zip",
    });
    expect(selectReleaseAsset(assets, "darwin", "x64", "mac-zip")).toEqual({
      asset: assets[4],
      resolvedMode: "mac-zip",
    });
    expect(selectReleaseAsset(assets, "darwin", "arm64", "installer")).toEqual({
      asset: assets[3],
      resolvedMode: "installer",
    });
    expect(selectReleaseAsset(assets, "win32", "x64", "installer")).toEqual({
      asset: assets[6],
      resolvedMode: "installer",
    });
    expect(selectReleaseAsset(assets, "linux", "x64", "installer")).toEqual({
      asset: assets[7],
      resolvedMode: "installer",
    });
  });

  it("parses GitHub release JSON fallback with assets and ignores drafts", () => {
    expect(parseGithubReleaseFallback({ draft: true, tag_name: "v0.9.0" }, "0.1.0")).toBeNull();

    const base = "https://github.com/MrDgbot/meeting-notes/releases/download/v0.2.0";
    const newer = parseGithubReleaseFallback(
      {
        tag_name: "v0.2.0",
        name: "Meeting Notes v0.2.0",
        published_at: "2026-12-01T10:00:00Z",
        body: "## 更新内容\n- 自动更新",
        html_url: "https://github.com/MrDgbot/meeting-notes/releases/tag/v0.2.0",
        assets: [
          {
            name: "Meeting-Notes-0.2.0-arm64-mac.zip",
            browser_download_url: `${base}/Meeting-Notes-0.2.0-arm64-mac.zip`,
            size: 123456,
          },
          {
            name: "SHA256SUMS.txt",
            browser_download_url: `${base}/SHA256SUMS.txt`,
            size: 512,
          },
        ],
      },
      "0.1.0",
      { platform: "darwin", arch: "arm64", baseInstallMode: "mac-zip" },
    );
    expect(newer?.hasUpdate).toBe(true);
    expect(newer?.installMode).toBe("mac-zip");
    expect(newer?.info.version).toBe("0.2.0");
    expect(newer?.info.releaseNotes).toContain("自动更新");
    expect(newer?.info.assetName).toBe("Meeting-Notes-0.2.0-arm64-mac.zip");
    expect(newer?.info.assetSize).toBe(123456);
    expect(newer?.info.sha256Url).toBe(`${base}/SHA256SUMS.txt`);

    const same = parseGithubReleaseFallback({ tag_name: "v0.1.0", body: "init" }, "0.1.0");
    expect(same?.hasUpdate).toBe(false);
  });
});
