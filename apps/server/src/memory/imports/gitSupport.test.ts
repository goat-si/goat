import { describe, expect, it } from "vitest";
import { isSupportedGitVersion } from "./gitSupport.ts";

describe("isSupportedGitVersion", () => {
  it("accepts the version strings that Git for Windows, Apple Git and upstream Git print", () => {
    expect(isSupportedGitVersion("git version 2.55.0.windows.3\n")).toBe(true);
    expect(isSupportedGitVersion("git version 2.50.1 (Apple Git-155)\n")).toBe(true);
    expect(isSupportedGitVersion("git version 2.48.0\n")).toBe(true);
  });

  it("refuses versions outside the support policy and unknown suffixes", () => {
    expect(isSupportedGitVersion("git version 2.47.1.windows.1\n")).toBe(false);
    expect(isSupportedGitVersion("git version 3.0.0\n")).toBe(false);
    expect(isSupportedGitVersion("git version 2.55.0.windowsX\n")).toBe(false);
    expect(isSupportedGitVersion("git version 2.55.0.vfs.0.0\n")).toBe(false);
  });
});
