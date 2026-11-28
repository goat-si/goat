import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { repointLauncher } from "./update.ts";

it.layer(NodeServices.layer)("Windows launcher update", (it) => {
  it.effect("repoints a recorded launcher outside PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const baseDir = path.join(root, "home");
      const runtime = path.join(baseDir, "runtime");
      const launcher = path.join(root, "custom bin", "goat.cmd");
      const old = path.join(runtime, "goat", "versions", "1", "goat.exe");
      const target = path.join(runtime, "goat", "versions", "2", "goat.exe");
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, `@echo off\r\n"${old}" %*`);
      yield* fs.writeFileString(path.join(runtime, "launchers"), `${launcher}\r\n`);
      const result = yield* repointLauncher({ launchedAs: old, baseDir, targetEntryPath: target });
      assert.equal(Option.getOrUndefined(result), launcher);
      assert.equal(yield* fs.readFileString(launcher), `@echo off\r\n"${target}" %*`);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
    ),
  );
});
