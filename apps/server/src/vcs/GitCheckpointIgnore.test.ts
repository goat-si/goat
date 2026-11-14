import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layer = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-checkpoint-ignore-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each(["", "sub"])(
  "checkpoint capture keeps new files in workspace %s with a blank CRLF ignore line",
  (subdirectory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "goat-checkpoint-crlf-" });
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test", cwd: parent, args });
      yield* git(["init"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@test.com"]);
      yield* fs.writeFileString(path.join(parent, "tracked.txt"), "initial\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "initial"]);
      yield* fs.writeFileString(path.join(parent, ".gitignore"), "a.txt\r\n\r\nb.txt\r\n");
      const cwd = path.join(parent, subdirectory);
      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "notes.md"), "notes\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/crlf");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const notesPath = subdirectory === "" ? "notes.md" : `${subdirectory}/notes.md`;
      assert.include(
        (yield* git(["ls-tree", "-r", "--name-only", checkpointRef])).stdout.split("\n"),
        notesPath,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
