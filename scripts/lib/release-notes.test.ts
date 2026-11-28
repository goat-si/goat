import { expect, it } from "vite-plus/test";
import { renderReleaseNotes, RELEASE_SIGNING_NOTICE } from "./release-notes.ts";

it("renders the version, UTC date, platform file table, and exact signing notice without source history", () => {
  const notes = renderReleaseNotes("0.1.0-nightly.20261012.1", "2026-10-12", [
    "GOAT-0.1.0-arm64.dmg",
    "GOAT-0.1.0-mac.zip",
    "GOAT-0.1.0-nightly.20261012.1-arm64.zip",
    "GOAT-0.1.0-nightly.20261012.1-arm64.zip.blockmap",
    "GOAT-Setup-arm64.exe",
    "GOAT-arm64.AppImage",
    "GOAT-arm64.deb",
    "goat-0.1.0-nightly.20261012.1-darwin-arm64.tar.gz",
    "goat-0.1.0-nightly.20261012.1-win32-x64.zip",
    "nightly.yml",
    "nightly-mac.yml",
    "nightly-linux-arm64.yml",
    "SHA256SUMS",
    "THIRD_PARTY_NOTICES.md",
  ]);
  expect(notes).toContain("GOAT 0.1.0-nightly.20261012.1\n\nUTC date: 2026-10-12");
  expect(notes).toContain("| mac | `GOAT-0.1.0-arm64.dmg` |");
  expect(notes).toContain("| mac | `GOAT-0.1.0-nightly.20261012.1-arm64.zip` |");
  expect(notes).toContain("| mac | `GOAT-0.1.0-nightly.20261012.1-arm64.zip.blockmap` |");
  expect(notes).toContain("| win | `GOAT-Setup-arm64.exe` |");
  expect(notes).toContain("| win | `nightly.yml` |");
  expect(notes).toContain("| linux | `GOAT-arm64.AppImage` |");
  expect(notes).toContain("| cli | `goat-0.1.0-nightly.20261012.1-darwin-arm64.tar.gz` |");
  expect(notes).toContain("| cli | `goat-0.1.0-nightly.20261012.1-win32-x64.zip` |");
  expect(notes).toContain("| other | `SHA256SUMS` |");
  expect(notes).toContain(RELEASE_SIGNING_NOTICE);
  expect(notes).not.toMatch(/https?:|commit|pull request|\/pull\//i);
});

it("keeps highlights as plain text above the platform table", () => {
  const notes = renderReleaseNotes(
    "0.1.14",
    "2026-11-26",
    ["GOAT.dmg"],
    ["Handle <offline> & @mentions", "Open [files](link)"],
  );
  expect(notes).toContain(
    "## What's changed\n\n- Handle &lt;offline&gt; &amp; &#64;mentions\n- Open &#91;files&#93;&#40;link&#41;\n\n| Platform | File |",
  );
});
