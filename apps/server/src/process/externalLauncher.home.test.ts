import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest, windowsHost } from "./externalLauncher.testkit.ts";

it.effect.skipIf(windowsHost)(
  "expands host home paths for editor targets, project roots and reveal",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "goat-editors-" });
      for (const name of ["open", "code", "idea"]) {
        yield* fs.writeFileString(path.join(bin, name), "#!/bin/sh\n");
        yield* fs.chmod(path.join(bin, name), 0o755);
      }
      const spawned: ChildProcess.StandardCommand[] = [];
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({ editor: "vscode", cwd: "~/notes/todo.md:3" });
        yield* launcher.launchEditor({
          editor: "idea",
          cwd: "~/notes/todo.md:3",
          projectRoot: "~/notes",
        });
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "~/notes/todo.md",
          reveal: true,
        });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "darwin",
            env: { PATH: bin },
            existingPaths: ["/Users/server/notes/todo.md"],
            onSpawn: (command) => spawned.push(command),
          }),
        ),
        Effect.provideService(HostProcess.HomeDirectory, "/Users/server"),
      );
      assert.deepEqual(
        spawned.map((command) => command.args),
        [
          ["--goto", "/Users/server/notes/todo.md:3"],
          ["/Users/server/notes", "--line", "3", "/Users/server/notes/todo.md"],
          ["-R", "/Users/server/notes/todo.md"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
