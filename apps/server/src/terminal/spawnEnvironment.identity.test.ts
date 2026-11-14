import { describe, expect, it } from "vite-plus/test";
import packageJson from "../../package.json" with { type: "json" };
import { createTerminalSpawnEnv } from "./spawnEnvironment.ts";

describe("terminal identity", () => {
  it.each([
    [
      "linux",
      { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455" },
      { TERM_PROGRAM: "", TERM_PROGRAM_VERSION: "custom-version" },
    ],
    [
      "win32",
      { term_program: "Apple_Terminal", Term_Program_Version: "455" },
      { Term_Program: "", term_program_version: "custom-version" },
    ],
  ] as const)("identifies GOAT and allows overrides on %s", (platform, parent, overrides) => {
    const frozen = Object.freeze(parent);
    for (const [env, expected] of [
      [createTerminalSpawnEnv(frozen, undefined, platform, "/home"), ["goat", packageJson.version]],
      [createTerminalSpawnEnv(frozen, overrides, platform, "/home"), ["", "custom-version"]],
    ] as const) {
      for (const [index, key] of ["TERM_PROGRAM", "TERM_PROGRAM_VERSION"].entries()) {
        expect(
          Object.entries(env)
            .filter(([name]) => name.toUpperCase() === key)
            .map(([, value]) => value),
        ).toEqual([expected[index]]);
      }
    }
    expect(frozen).toEqual(parent);
  });
});
