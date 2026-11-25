import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { readEnvironmentFromWindowsShell } from "./shell.ts";

describe("Windows telemetry capture", () => {
  effectIt.effect("captures telemetry opt-outs across Windows scopes before opt-ins", () =>
    Effect.gen(function* () {
      let command = "";
      yield* readEnvironmentFromWindowsShell(
        ["GOAT_TELEMETRY_ENABLED", "T3CODE_TELEMETRY_ENABLED", "FNM_DIR"],
        {},
        (_file, args) => {
          command = String(args.at(-1));
          return Effect.succeedSome("");
        },
      );
      for (const name of ["GOAT_TELEMETRY_ENABLED", "T3CODE_TELEMETRY_ENABLED"]) {
        const section =
          command.split(`__GOAT_ENV_${name}_START__`)[1]?.split(`__GOAT_ENV_${name}_END__`)[0] ??
          "";
        expect(section).toMatch(/Process.*User.*Machine/);
        expect(section).toMatch(/\.Trim\(\)\.ToLowerInvariant\(\)/);
        for (const value of ["true", "1", "yes", "on"]) expect(section).toContain(`'${value}'`);
        expect(section).toMatch(/-not(?:in|contains)/i);
      }
      const other =
        command.split("__GOAT_ENV_FNM_DIR_START__")[1]?.split("__GOAT_ENV_FNM_DIR_END__")[0] ?? "";
      expect(other).not.toMatch(/ToLowerInvariant/);
    }),
  );
});
