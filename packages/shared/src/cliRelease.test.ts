import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  isPublishableCliReleaseVersion,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("treats only stable, nightly and preview versions as publishable", () => {
    expect(isPublishableCliReleaseVersion("0.1.0")).toBe(true);
    expect(isPublishableCliReleaseVersion("0.1.0-nightly.20261019.194")).toBe(true);
    expect(isPublishableCliReleaseVersion("1.2.3-preview.20260911.4")).toBe(true);
    expect(isPublishableCliReleaseVersion("0.1.0-dev.1792420473.g7b523f265")).toBe(false);
    expect(isPublishableCliReleaseVersion("0.1.0-pr.412.3")).toBe(false);
    expect(isPublishableCliReleaseVersion("0.1.0-nightly.2026.1")).toBe(false);
  });

  it("resolves download URLs under the tagged release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/goat-si/goat-releases/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/goat/")).toBe(
      "https://mirror.example/goat/v1.2.3",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  goat-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *goat-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("goat-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("goat-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  it("pages through the release index at the largest page GitHub allows", () => {
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/goat-si/goat-releases/releases?per_page=100&page=1",
    );
    expect(cliReleaseIndexPageUrl(3)).toContain("page=3");
  });
});
