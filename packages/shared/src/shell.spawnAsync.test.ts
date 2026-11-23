import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import * as HostProcess from "./HostProcess.ts";
import { CommandResolutionCache, resolveSpawnCommand, SpawnExecutableResolution } from "./shell.ts";

it.layer(NodeServices.layer)("asynchronous spawn resolution", (it) => {
  it.effect("awaits an asynchronous executable resolver before choosing how to spawn", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("agent", ["hello"], {
        env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(SpawnExecutableResolution, async () => "C:\\bin\\agent.cmd"),
      );
      expect(command.shell).toBe(true);
      expect(command.command).toContain("agent.cmd");
    }),
  );

  it.effect("yields while discovering a Windows executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-spawn-" });
        const executable = path.join(directory, "tool.EXE");
        yield* fs.writeFileString(executable, "");
        let settled = false;
        const pending = Promise.resolve(
          SpawnExecutableResolution.defaultValue()(executable, "win32", { PATHEXT: ".EXE;.CMD" }),
        ).then((value) => {
          settled = true;
          return value;
        });
        try {
          yield* Effect.promise(() => Promise.resolve());
          expect(settled).toBe(false);
        } finally {
          expect(yield* Effect.promise(() => pending)).toBe(executable);
        }
      }),
    ),
  );
});
