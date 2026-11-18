import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { repointCommittedLaunchers } from "./repointCommittedLaunchers.ts";

it.layer(NodeServices.layer)("goat command after a committed remote update", (it) => {
  it.effect("moves recorded and default goat links into this home to the new runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "goat-repoint-" }),
      );
      const baseDir = path.join(root, ".goat");
      const runtime = (version: string) =>
        path.join(baseDir, "runtime/goat/versions", version, "goat");
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* fs.makeDirectory(path.dirname(runtime(version)), { recursive: true });
        yield* fs.writeFileString(runtime(version), "", { mode: 0o755 });
      }
      const home = path.join(root, "home");
      const defaultLink = path.join(home, ".local/bin/goat");
      const recordedLink = path.join(root, "custom-bin/goat");
      const otherHomeLink = path.join(root, "other-bin/goat");
      const regularFile = path.join(root, "file-bin/goat");
      for (const link of [defaultLink, recordedLink, otherHomeLink, regularFile]) {
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      }
      yield* fs.symlink(runtime("1.0.0"), defaultLink);
      yield* fs.symlink(runtime("1.0.0"), recordedLink);
      const otherRuntime = path.join(root, "other/.goat/runtime/goat/versions/1.0.0/goat");
      yield* fs.makeDirectory(path.dirname(otherRuntime), { recursive: true });
      yield* fs.writeFileString(otherRuntime, "");
      yield* fs.symlink(otherRuntime, otherHomeLink);
      yield* fs.writeFileString(regularFile, "#!/bin/sh\n", { mode: 0o755 });
      yield* fs.writeFileString(
        path.join(baseDir, "runtime/launchers"),
        `\n${recordedLink}\n${otherHomeLink}\n${regularFile}\n`,
      );

      yield* repointCommittedLaunchers({ baseDir, targetVersion: "1.1.0" }).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
      );

      assert.equal(yield* fs.readLink(defaultLink), runtime("1.1.0"));
      assert.equal(yield* fs.readLink(recordedLink), runtime("1.1.0"));
      assert.equal(yield* fs.readLink(otherHomeLink), otherRuntime);
      assert.equal(yield* fs.readFileString(regularFile), "#!/bin/sh\n");
      // No temporary link directory is left beside a moved launcher.
      assert.deepEqual(yield* fs.readDirectory(path.dirname(recordedLink)), ["goat"]);
    }),
  );

  it.effect(
    "leaves a recorded goat link alone when its version directory belongs to another home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-repoint-" }),
        );
        const baseDir = path.join(root, "home-a");
        const versions = path.join(baseDir, "runtime/goat/versions");
        const anotherVersion = path.join(root, "home-b/runtime/goat/versions/1.0.0");
        const launcher = path.join(root, "goat");
        const aliasedVersion = path.join(versions, "1.0.0");
        const originalTarget = path.join(aliasedVersion, "goat");
        yield* fs.makeDirectory(anotherVersion, { recursive: true });
        yield* fs.writeFileString(path.join(anotherVersion, "goat"), "", { mode: 0o755 });
        yield* fs.makeDirectory(path.join(versions, "1.1.0"), { recursive: true });
        yield* fs.writeFileString(path.join(versions, "1.1.0/goat"), "", { mode: 0o755 });
        yield* fs.symlink(anotherVersion, aliasedVersion);
        yield* fs.symlink(originalTarget, launcher);
        yield* fs.writeFileString(path.join(baseDir, "runtime/launchers"), `${launcher}\n`);

        yield* repointCommittedLaunchers({ baseDir, targetVersion: "1.1.0" }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
        );

        assert.equal(yield* fs.readLink(launcher), originalTarget);
        assert.equal(yield* fs.realPath(launcher), path.join(anotherVersion, "goat"));
      }),
  );
});
