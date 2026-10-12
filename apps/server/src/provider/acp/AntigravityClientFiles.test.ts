import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  readAntigravityClientTextFile,
  writeAntigravityClientTextFile,
} from "./AntigravityClientFiles.ts";

/**
 * Another process racing the write: it puts the real layout back before every
 * path check and swaps a symlink in right after, so each check passes and only
 * an operation that resolves a path again can be redirected.
 */
type Adversary = {
  readonly restore: Effect.Effect<void, PlatformError.PlatformError>;
  readonly swap: Effect.Effect<void, PlatformError.PlatformError>;
};

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
  const write = (requestPath: string, content: string, adversary?: Adversary) => {
    const checked = <A, E>(check: Effect.Effect<A, E>) =>
      adversary === undefined
        ? check
        : adversary.restore.pipe(
            Effect.orDie,
            Effect.andThen(check),
            Effect.ensuring(Effect.orDie(adversary.swap)),
          );
    const racedFileSystem: FileSystem.FileSystem = {
      ...fileSystem,
      realPath: (target) => checked(fileSystem.realPath(target)),
      readLink: (target) => checked(fileSystem.readLink(target)),
      exists: (target) => checked(fileSystem.exists(target)),
    };
    return writeAntigravityClientTextFile({
      fileSystem: racedFileSystem,
      path,
      allowedRoots: [workspace],
      request: { sessionId: "session", path: requestPath, content },
    });
  };
  return { fileSystem, path, workspace, outside, write };
});

describe("AntigravityClientFiles", () => {
  it.effect("writes into folders whose names start with '..'", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, write } = yield* setup;
      const target = path.join(workspace, "..cache", "--version", "file.txt");
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

  it.effect("refuses a checked directory that is swapped for a symlink around each check", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* setup;
      const directory = path.join(workspace, "src");
      const held = path.join(workspace, "held");
      yield* fileSystem.makeDirectory(directory);
      yield* fileSystem.writeFileString(path.join(outside, "victim.txt"), "keep");
      const error = yield* write(path.join(directory, "victim.txt"), "no", {
        restore: Effect.gen(function* () {
          if (!(yield* fileSystem.exists(held))) return;
          yield* fileSystem.remove(directory);
          yield* fileSystem.rename(held, directory);
        }),
        swap: Effect.gen(function* () {
          if (yield* fileSystem.exists(held)) return;
          yield* fileSystem.rename(directory, held);
          yield* fileSystem.symlink(outside, directory);
        }),
      }).pipe(Effect.flip);
      expect(error.message).toContain("outside the session workspace");
      expect(yield* fileSystem.readDirectory(outside)).toEqual(["victim.txt"]);
      expect(yield* fileSystem.readFileString(path.join(outside, "victim.txt"))).toBe("keep");
      expect(yield* fileSystem.readDirectory(held)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a workspace root that is swapped for a symlink around each check", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* setup;
      const held = `${workspace}-held`;
      yield* fileSystem.writeFileString(path.join(outside, "victim.txt"), "keep");
      const error = yield* write(path.join(workspace, "victim.txt"), "no", {
        restore: Effect.gen(function* () {
          if (!(yield* fileSystem.exists(held))) return;
          yield* fileSystem.remove(workspace);
          yield* fileSystem.rename(held, workspace);
        }),
        swap: Effect.gen(function* () {
          if (yield* fileSystem.exists(held)) return;
          yield* fileSystem.rename(workspace, held);
          yield* fileSystem.symlink(outside, workspace);
        }),
      }).pipe(Effect.flip);
      expect(error.message).toContain("outside the session workspace");
      expect(yield* fileSystem.readFileString(path.join(outside, "victim.txt"))).toBe("keep");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a missing directory that appears as a symlink around each check", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* setup;
      const link = path.join(workspace, "new");
      const error = yield* write(path.join(link, "deeper", "x.txt"), "no", {
        restore: fileSystem.remove(link, { force: true }),
        swap: fileSystem.symlink(outside, link).pipe(Effect.ignore),
      }).pipe(Effect.flip);
      expect(error.message).toContain("outside the session workspace");
      expect(yield* fileSystem.readDirectory(outside)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the temp file when the final rename fails", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, write } = yield* setup;
      const target = path.join(workspace, "folder");
      yield* fileSystem.makeDirectory(target);
      yield* fileSystem.writeFileString(path.join(target, "inner.txt"), "keep");
      const error = yield* write(target, "no").pipe(Effect.flip);
      expect(error.message).toContain("Could not write");
      expect(yield* fileSystem.readDirectory(workspace)).toEqual(["folder"]);
      expect(yield* fileSystem.readDirectory(target)).toEqual(["inner.txt"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("an interrupted write leaves either the whole file or nothing", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, write } = yield* setup;
      const target = path.join(workspace, "big.txt");
      const content = "x".repeat(4 * 1024 * 1024);
      const fiber = yield* write(target, content).pipe(Effect.forkChild);
      yield* Fiber.interrupt(fiber);
      const entries = yield* fileSystem.readDirectory(workspace);
      expect(entries.filter((entry) => entry !== "big.txt")).toEqual([]);
      if (entries.includes("big.txt")) {
        expect(yield* fileSystem.readFileString(target)).toBe(content);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps an existing file's mode under a restrictive umask and masks new files",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => process.umask(0o077)),
          (previous) => Effect.sync(() => process.umask(previous)),
        );
        const { fileSystem, path, workspace, write } = yield* setup;
        const shared = path.join(workspace, "shared.sh");
        yield* fileSystem.writeFileString(shared, "old");
        yield* fileSystem.chmod(shared, 0o777);
        yield* write(shared, "new");
        expect(yield* fileSystem.readFileString(shared)).toBe("new");
        expect((yield* fileSystem.stat(shared)).mode & 0o7777).toBe(0o777);

        const fresh = path.join(workspace, "fresh.txt");
        yield* write(fresh, "new");
        expect((yield* fileSystem.stat(fresh)).mode & 0o777).toBe(0o600);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
