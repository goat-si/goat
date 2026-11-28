import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest } from "./externalLauncher.testkit.ts";
import { WindowsVerbatimSpawn } from "./windowsVerbatimSpawn.ts";

it.effect("refuses to reveal a missing file before spawning Explorer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(dir, "explorer.EXE"), "");
    const missing = path.join(dir, "missing.txt");
    const spawned: string[] = [];
    const result = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher
        .launchEditor({ editor: "file-manager", cwd: missing, reveal: true })
        .pipe(Effect.exit);
    }).pipe(
      Effect.provideService(WindowsVerbatimSpawn, (command) =>
        Effect.sync(() => {
          spawned.push(command);
        }),
      ),
      Effect.provide(layerTest({ platform: "win32", env: { PATH: dir, PATHEXT: ".EXE" } })),
    );
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result))
      assert.instanceOf(
        Cause.squash(result.cause),
        ExternalLauncher.ExternalLauncherRevealTargetMissingError,
      );
    assert.deepEqual(spawned, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
