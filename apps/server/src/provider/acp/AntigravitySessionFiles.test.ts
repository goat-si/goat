import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { retireAntigravityRuntimeTempDirs } from "./AntigravitySessionFiles.ts";

it.layer(NodeServices.layer)("retireAntigravityRuntimeTempDirs", (it) => {
  it.effect("moves leftovers aside at once and deletes them, plus older retirees, later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped();
      const runtimeTemp = path.join(parent, "abc123");
      const orphan = path.join(runtimeTemp, "run-orphan", "_MEI123");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
      yield* fs.makeDirectory(path.join(parent, "abc123.old-unfinished", "runtime"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(parent, "other-instance"));

      const removeRetired = yield* retireAntigravityRuntimeTempDirs(runtimeTemp);
      expect(yield* fs.exists(runtimeTemp)).toBe(false);
      const retired = (yield* fs.readDirectory(parent)).filter((entry) =>
        entry.startsWith("abc123.old-"),
      );
      expect(retired).toHaveLength(2);

      yield* removeRetired;
      expect((yield* fs.readDirectory(parent)).toSorted()).toEqual(["other-instance"]);
    }).pipe(Effect.scoped),
  );

  it.effect("limits each retirement sweep to 32 private directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped();
      for (let index = 0; index < 35; index++) {
        yield* fs.makeDirectory(path.join(parent, `abc.old-${index}`));
      }
      yield* fs.makeDirectory(path.join(parent, "other.old-1"));
      const removeRetired = yield* retireAntigravityRuntimeTempDirs(path.join(parent, "abc"));
      yield* removeRetired;
      const remaining = yield* fs.readDirectory(parent);
      expect(remaining.filter((entry) => entry.startsWith("abc.old-"))).toHaveLength(3);
      expect(remaining).toContain("other.old-1");
    }).pipe(Effect.scoped),
  );

  it.effect.each(["full disk", "rename failure"])("deletes leftovers inline on %s", (failure) =>
    Effect.gen(function* () {
      const removed: Array<string> = [];
      const fs = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        makeTempDirectory: () =>
          failure === "rename failure"
            ? Effect.succeed("/state/retired")
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "makeTempDirectory",
                  description: "ENOSPC",
                }),
              ),
        rename: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "rename",
              description: "rename failed",
            }),
          ),
        remove: (path) => Effect.sync(() => void removed.push(path)),
        readDirectory: () => Effect.succeed([]),
      });

      const removeRetired = yield* retireAntigravityRuntimeTempDirs(
        "/state/antigravity-tmp/abc123",
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      yield* removeRetired;
      expect(removed).toEqual(["/state/antigravity-tmp/abc123"]);
    }),
  );
});
