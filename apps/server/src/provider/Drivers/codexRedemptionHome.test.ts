import { describe, expect, it } from "vite-plus/test";

import { codexHomeFor } from "./codexRedemptionHome.ts";

describe("codexHomeFor", () => {
  const posix = { platform: "linux", homeDirectory: "/server", sep: "/" } as const;
  const windows = { platform: "win32", homeDirectory: "C:\\Server", sep: "\\" } as const;

  it("keeps CODEX_HOME exactly as written", () => {
    expect(codexHomeFor({ CODEX_HOME: "/a/link/../acct " }, posix)).toBe("/a/link/../acct ");
  });

  it("uses .codex under the HOME the process receives, else the server's home", () => {
    expect(codexHomeFor({ HOME: "/person", USERPROFILE: "/other" }, posix)).toBe("/person/.codex");
    expect(codexHomeFor({}, posix)).toBe("/server/.codex");
  });

  it("uses USERPROFILE on Windows, as Codex does", () => {
    expect(codexHomeFor({ HOME: "/person", USERPROFILE: "C:\\Users\\p" }, windows)).toBe(
      "C:\\Users\\p\\.codex",
    );
    expect(codexHomeFor({ HOME: "/person" }, windows)).toBe("C:\\Server\\.codex");
  });
});
