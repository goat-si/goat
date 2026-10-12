import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readAntigravityClientTextFile,
  writeAntigravityClientTextFile,
} from "./AntigravityClientFiles.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-files-" }),
  );
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  yield* fileSystem.makeDirectory(workspace);
  yield* fileSystem.makeDirectory(outside);
  const write = (requestPath: string, content: string) =>
    writeAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots: [workspace],
      request: { sessionId: "session", path: requestPath, content },
    });
  return { fileSystem, path, workspace, outside, write };
});

describe("AntigravityClientFiles", () => {
  it.effect("writes into folders whose names start with '..'", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, write } = yield* setup;
      const target = path.join(workspace, "..cache", "nested", "file.txt");
      yield* write(target, "hello");
      expect(yield* fileSystem.readFileString(target)).toBe("hello");
      const read = yield* readAntigravityClientTextFile({
        fileSystem,
        path,
        allowedRoots: [workspace],
        request: { sessionId: "session", path: target },
      });
      expect(read.content).toBe("hello");
      // No temp files are left behind.
      expect(yield* fileSystem.readDirectory(path.dirname(target))).toEqual(["file.txt"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("still refuses paths that climb out of the workspace", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* setup;
      const error = yield* write(path.join(workspace, "..", "outside", "x.txt"), "no").pipe(
        Effect.flip,
      );
      expect(error.message).toContain("outside the session workspace");
      expect(yield* fileSystem.exists(path.join(outside, "x.txt"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("overwrites an existing file and keeps its mode", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, write } = yield* setup;
      const target = path.join(workspace, "script.sh");
      yield* fileSystem.writeFileString(target, "old", { mode: 0o755 });
      yield* fileSystem.chmod(target, 0o755);
      yield* write(target, "new");
      expect(yield* fileSystem.readFileString(target)).toBe("new");
      expect((yield* fileSystem.stat(target)).mode & 0o777).toBe(0o755);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to write through a symlinked directory that leaves the workspace", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* setup;
      yield* fileSystem.symlink(outside, path.join(workspace, "escape"));
      const error = yield* write(path.join(workspace, "escape", "x.txt"), "no").pipe(Effect.flip);
      expect(error.message).toContain("outside the session workspace");
      expect(yield* fileSystem.readDirectory(outside)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
