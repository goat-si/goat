import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";

import {
  checkWorktreesDirectory,
  resolveAvailableWorktreesDirectory,
  resolveWorktreesDirectory,
} from "./worktreesDirectory.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-worktrees-dir-" });
  const check = (directory: string) => checkWorktreesDirectory(directory, fileSystem, path);
  return { fileSystem, path, root, check };
});

it.layer(NodeServices.layer)("worktreesDirectory", (it) => {
  describe("resolveWorktreesDirectory", () => {
    it.effect("reads a Git Bash drive path as that drive on a Windows server", () =>
      Effect.gen(function* () {
        const win32 = yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32));
        const resolve = (setting: string) =>
          resolveWorktreesDirectory(
            setting,
            "C:\\goat\\worktrees",
            win32,
            "C:\\Users\\super",
            "win32",
          );
        assert.equal(resolve("/d/goat-worktrees"), "D:\\goat-worktrees");
        assert.equal(resolve("/cygdrive/e/wt/"), "E:\\wt");
        assert.equal(resolve("D:/goat-worktrees"), "D:\\goat-worktrees");
        assert.equal(resolve("~/wt"), "C:\\Users\\super\\wt");
        assert.isNull(resolve("/d"));
      }),
    );

    it.effect("keeps /d/… an ordinary folder on POSIX", () =>
      Effect.gen(function* () {
        const posix = yield* Path.Path.pipe(Effect.provide(NodePath.layerPosix));
        assert.equal(
          resolveWorktreesDirectory("/d/goat-worktrees", "/default", posix, "/home/u", "linux"),
          "/d/goat-worktrees",
        );
      }),
    );
  });

  describe("checkWorktreesDirectory", () => {
    it.effect("accepts an existing folder and a missing leaf in a writable parent", () =>
      Effect.gen(function* () {
        const { path, root, check } = yield* setup;
        assert.equal(yield* check(root), null);
        assert.equal(yield* check(path.join(root, "new-leaf")), null);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a missing parent, a file, and a read-only folder", () =>
      Effect.gen(function* () {
        const { fileSystem, path, root, check } = yield* setup;
        assert.equal(yield* check(path.join(root, "gone", "worktrees")), "missing");

        const file = path.join(root, "file");
        yield* fileSystem.writeFileString(file, "");
        assert.equal(yield* check(file), "not-a-directory");

        if ((yield* HostProcess.Platform) !== "win32" && process.getuid?.() !== 0) {
          const readOnly = path.join(root, "read-only");
          yield* fileSystem.makeDirectory(readOnly);
          yield* fileSystem.chmod(readOnly, 0o500);
          yield* Effect.addFinalizer(() => fileSystem.chmod(readOnly, 0o700).pipe(Effect.ignore));
          assert.equal(yield* check(readOnly), "not-writable");
          assert.equal(yield* check(path.join(readOnly, "leaf")), "not-writable");
        }
      }).pipe(Effect.scoped),
    );

    it.effect("treats a missing path under a mount container as an unmounted drive", () =>
      Effect.gen(function* () {
        const { fileSystem } = yield* setup;
        // Mount containers are POSIX paths, so a Windows host checks them with POSIX rules.
        const posix = yield* Path.Path.pipe(Effect.provide(NodePath.layerPosix));
        const check = (directory: string) => checkWorktreesDirectory(directory, fileSystem, posix);
        const drive = `/Volumes/goat-test-unmounted-${process.pid}`;
        assert.equal(yield* check(`${drive}/goat-worktrees`), "unmounted");
        assert.equal(yield* check(drive), "unmounted");
        assert.equal(yield* check(`/mnt/goat-test-unmounted-${process.pid}`), "unmounted");
        assert.equal(yield* fileSystem.exists(drive), false);
      }).pipe(Effect.scoped),
    );
  });

  describe("resolveAvailableWorktreesDirectory", () => {
    it.effect("uses the configured folder when available and falls back otherwise", () =>
      Effect.gen(function* () {
        const { fileSystem, path, root } = yield* setup;
        const defaultDir = path.join(root, "default");
        const resolve = (setting: string) =>
          resolveAvailableWorktreesDirectory({ setting, defaultDir }, fileSystem, path);

        assert.deepStrictEqual(yield* resolve(""), {
          configured: "",
          directory: defaultDir,
          unavailable: null,
        });
        const custom = path.join(root, "custom");
        assert.deepStrictEqual(yield* resolve(custom), {
          configured: custom,
          directory: custom,
          unavailable: null,
        });
        const gone = path.join(root, "gone", "worktrees");
        assert.deepStrictEqual(yield* resolve(gone), {
          configured: gone,
          directory: defaultDir,
          unavailable: { reason: "missing", path: gone },
        });
        assert.deepStrictEqual(yield* resolve("relative/worktrees"), {
          configured: "relative/worktrees",
          directory: defaultDir,
          unavailable: { reason: "invalid", path: null },
        });
      }).pipe(Effect.scoped),
    );
  });
});
