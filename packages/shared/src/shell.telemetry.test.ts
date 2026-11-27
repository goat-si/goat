// @effect-diagnostics nodeBuiltinImport:off -- Executes PowerShell to test the generated command.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import * as HostProcess from "./HostProcess.ts";
import { windowsEnvironmentValueCommand } from "./shell.ts";
import { windowsTelemetryValueSelectionCommand } from "./windowsTelemetryValueSelection.ts";

const powershell = ["pwsh", "powershell"].find(
  (command) =>
    NodeChildProcess.spawnSync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"])
      .status === 0,
);

describe("Windows telemetry selection", () => {
  it.runIf(HostProcess.Platform.defaultValue() === "win32" || powershell !== undefined)(
    "ignores blanks and prefers opt-outs across scopes",
    () => {
      for (const [values, expected] of [
        ["@('   ','false')", "false"],
        ["@('true','false')", "false"],
        ["@('true')", "true"],
        ["@('','TRUE')", "TRUE"],
        ["@()", ""],
      ] as const) {
        const command = `${windowsTelemetryValueSelectionCommand(values)}; if ($null -ne $value) { [Console]::Write($value) }`;
        const result = NodeChildProcess.spawnSync(
          powershell ?? "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", command],
          { encoding: "utf8" },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(expected);
      }
    },
  );
  it.runIf(HostProcess.Platform.defaultValue() === "win32" || powershell !== undefined)(
    "applies the selection to both telemetry variables across scopes",
    () => {
      for (const name of ["GOAT_TELEMETRY_ENABLED", "T3CODE_TELEMETRY_ENABLED"]) {
        let command = windowsEnvironmentValueCommand(name);
        for (const [scope, value] of [
          ["Process", "'   '"],
          ["User", "'false'"],
          ["Machine", "'true'"],
        ] as const) {
          command = command.replace(
            `[Environment]::GetEnvironmentVariable('${name}','${scope}')`,
            value,
          );
        }
        const result = NodeChildProcess.spawnSync(
          powershell ?? "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", `${command}; [Console]::Write($value)`],
          { encoding: "utf8" },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("false");
      }
    },
  );
});
