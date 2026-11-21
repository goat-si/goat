import { describe, expect, it } from "vite-plus/test";

import { isSshRemoteUrl } from "./sourceControl.ts";

describe("isSshRemoteUrl", () => {
  it("recognizes a single-component SCP path without confusing a drive or remote helper", () => {
    expect(isSshRemoteUrl("gitserver:repo.git")).toBe(true);
    expect(isSshRemoteUrl("C:repo.git")).toBe(false);
    expect(isSshRemoteUrl("hg::repo.git")).toBe(false);
  });
  it.each([
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "github.com:owner/repo.git",
    "github-work:owner/repo.git",
  ])("reads %s as SSH", (remoteUrl) => {
    expect(isSshRemoteUrl(remoteUrl)).toBe(true);
  });

  it.each([
    "https://github.com/owner/repo.git",
    "C:/repos/repo",
    "/srv/git/repo.git",
    "./team:group/repo",
    "file:///srv/git/repo.git",
    "hg::owner/repo",
  ])("does not read %s as SSH", (remoteUrl) => {
    expect(isSshRemoteUrl(remoteUrl)).toBe(false);
  });
});
