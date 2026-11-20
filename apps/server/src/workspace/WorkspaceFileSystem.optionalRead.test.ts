import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import { layerTest, makeTempDir } from "./WorkspaceFileSystem.testkit.ts";

it.layer(layerTest)("optional workspace reads", (it) => {
  it.effect("reports an optional file as absent when the workspace root was removed", () =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const path = yield* Path.Path;
      const cwd = path.join(yield* makeTempDir, "removed-worktree");
      expect(yield* files.readFile({ cwd, relativePath: "t3.json", allowMissing: true })).toEqual({
        relativePath: "t3.json",
        contents: "",
        byteLength: 0,
        truncated: false,
        exists: false,
      });
      const error = yield* files.readFile({ cwd, relativePath: "t3.json" }).pipe(Effect.flip);
      expect(error).toMatchObject({ operation: "realpath-workspace-root" });
      const escape = yield* files
        .readFile({ cwd, relativePath: "../t3.json", allowMissing: true })
        .pipe(Effect.flip);
      expect(escape).toMatchObject({ _tag: "WorkspacePathOutsideRootError" });
    }),
  );

  if (symlinksSupported)
    it.effect("rejects a dangling workspace root even for optional files", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const cwd = path.join(root, "linked-worktree");
        yield* fs.symlink(path.join(root, "removed-target"), cwd);
        const error = yield* files
          .readFile({ cwd, relativePath: "t3.json", allowMissing: true })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "realpath-workspace-root" });
      }),
    );
});
