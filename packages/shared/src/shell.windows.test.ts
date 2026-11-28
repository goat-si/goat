import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import { readEnvironmentFromWindowsShell } from "./shell.ts";

effectIt.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "reads a non-ASCII value from the real shell",
  () =>
    Effect.gen(function* () {
      const name = "T3CODE_TEST_NON_ASCII_PATH";
      const value = "C:\\Users\\Jürgen\\Grüße";
      vi.stubEnv(name, value);
      try {
        expect(yield* readEnvironmentFromWindowsShell([name])).toEqual({ [name]: value });
      } finally {
        vi.unstubAllEnvs();
      }
    }),
);

effectIt.effect("extracts environment variables from a PowerShell command", () =>
  Effect.gen(function* () {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(
      () =>
        "__GOAT_ENV_PATH_START__\nC:\\Users\\testuser\\AppData\\Roaming\\npm\n__GOAT_ENV_PATH_END__\n",
    );

    expect(
      yield* readEnvironmentFromWindowsShell(["PATH"], {}, (...args) =>
        Effect.try(() => execFile(...args)).pipe(Effect.option),
      ),
    ).toEqual({
      PATH: "C:\\Users\\testuser\\AppData\\Roaming\\npm",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
    expect(execFile.mock.calls[0]?.[1].at(-1)).toContain(
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    );
  }),
);
