import { describe, expect, it } from "vite-plus/test";
import { resolveShellCandidates } from "./shellCandidates.ts";

describe("resolveShellCandidates", () => {
  it.each([
    ["darwin", "/bin/bash", ["-l"]],
    ["darwin", "/opt/homebrew/bin/bash", ["-l"]],
    ["linux", "/bin/bash", undefined],
    ["win32", "C:\\Program Files\\Git\\bin\\bash.exe", undefined],
    ["win32", "C:/Program Files/Git/bin/bash.exe", undefined],
    ["darwin", "/bin/zsh", ["-o", "nopromptsp"]],
    ["linux", "/bin/zsh", ["-o", "nopromptsp"]],
    ["linux", "/opt/team\\zsh", undefined],
    ["win32", "pwsh.exe", ["-NoLogo"]],
  ] as const)("resolves platform shell args for %s %s", (platform, shell, expectedArgs) => {
    const [first] = resolveShellCandidates(() => shell, platform, {});
    expect(first?.shell).toBe(shell);
    expect(first?.args).toEqual(expectedArgs);
  });
});
