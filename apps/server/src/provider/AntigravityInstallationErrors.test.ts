import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { executableName, makeHarness, terminalState } from "./AntigravityInstallation.testkit.ts";

it.layer(NodeServices.layer)("Antigravity install errors", (it) => {
  it.effect("names a network failure rather than disk space", () =>
    Effect.gen(function* () {
      const { installation, validations } = yield* makeHarness({ connectTimeout: true });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).not.toMatch(/disk space/i);
      expect(state.message).toMatch(/connect|network|download/i);
      expect(validations).toEqual([]);
    }),
  );

  it.effect("reports the runtime's 16 KiB page-size failure", () =>
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.command === "getconf")
          return real.spawn(
            ChildProcess.make(process.execPath, ["-e", "console.log('4096')"], command.options),
          );
        if (
          ChildProcess.isStandardCommand(command) &&
          String(command.command).endsWith(executableName)
        )
          return real.spawn(
            ChildProcess.make(process.execPath, [
              "-e",
              "console.error('page-size.cc: Compile-time page size does not match runtime page size'); process.exit(1)",
            ]),
          );
        return real.spawn(command);
      });
      const { installation } = yield* makeHarness({
        arch: "arm64",
        useDefaultValidation: true,
        spawner,
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).toMatch(/page/i);
    }),
  );

  it.effect("rejects a 16 KiB linux-arm64 kernel before downloading", () =>
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.command === "getconf"
          ? real.spawn(
              ChildProcess.make(process.execPath, ["-e", "console.log('16384')"], command.options),
            )
          : real.spawn(command),
      );
      const { installation, requests } = yield* makeHarness({
        platform: "linux",
        arch: "arm64",
        spawner,
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).toMatch(/4 KiB/);
      expect(requests).toEqual([]);
    }),
  );

  it.effect("reports an unreadable page size instead of assuming compatibility", () =>
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.command === "getconf"
          ? real.spawn(
              ChildProcess.make(process.execPath, ["-e", "process.exit(3)"], command.options),
            )
          : real.spawn(command),
      );
      const { installation, requests } = yield* makeHarness({
        platform: "linux",
        arch: "arm64",
        spawner,
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).toMatch(/determine.*page size/i);
      expect(requests).toEqual([]);
    }),
  );
});
