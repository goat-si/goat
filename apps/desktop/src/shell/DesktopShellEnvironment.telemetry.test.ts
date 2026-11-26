import { envOutput, runShellEnvironment } from "./DesktopShellEnvironment.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

describe("DesktopShellEnvironment telemetry variables", () => {
  it.effect("keeps Windows telemetry opt-outs over inherited opt-ins", () =>
    Effect.gen(function* () {
      for (const [name, inherited, discovered, expected] of [
        ["GOAT_TELEMETRY_ENABLED", undefined, "false", "false"],
        ["GOAT_TELEMETRY_ENABLED", "true", "false", "false"],
        ["GOAT_TELEMETRY_ENABLED", "false", "true", "false"],
        ["T3CODE_TELEMETRY_ENABLED", "true", "false", "false"],
      ] as const) {
        const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows", [name]: inherited };
        yield* runShellEnvironment({
          env,
          platform: "win32",
          handler: (command) => {
            const capture = command._tag === "StandardCommand" ? String(command.args.at(-1)) : "";
            if (capture.includes(name)) {
              assert.match(capture, /GetEnvironmentVariable\('[^']+','User'\)/);
              assert.include(capture, "-notin");
              return envOutput({ PATH: "C:\\Windows", [name]: discovered });
            }
            return envOutput({ PATH: "C:\\Windows" });
          },
        });
        assert.equal(env[name], expected);
      }
    }),
  );

  it.effect.each([
    { platform: "win32", name: "GOAT_TELEMETRY_ENABLED" },
    { platform: "darwin", name: "OTEL_SDK_DISABLED" },
    { platform: "darwin", name: "GOAT_OTEL_SDK_DISABLED" },
    { platform: "win32", name: "OTEL_SDK_DISABLED" },
    { platform: "win32", name: "GOAT_OTEL_SDK_DISABLED" },
  ] as const)("loads $name from the shell profile on $platform", ({ platform, name }) =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const value = name === "GOAT_TELEMETRY_ENABLED" ? "false" : "true";
      yield* runShellEnvironment({
        env,
        platform,
        handler: (command) =>
          command._tag === "StandardCommand" && String(command.args.at(-1)).includes(name)
            ? envOutput({ PATH: "/usr/bin", [name]: value })
            : envOutput({ PATH: "/usr/bin" }),
      });
      assert.equal(env[name], value);
    }),
  );
});
