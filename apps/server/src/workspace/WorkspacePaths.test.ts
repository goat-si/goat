import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@goat/shared/HostProcess";

import * as WorkspacePaths from "./WorkspacePaths.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("normalizeWorkspaceRoot on a Windows server", () => {
  const existing = "C:\\Users\\super\\Developer\\goat";
  // A Windows path module and one existing folder stand in for a Windows filesystem.
  const normalizeOnWindows = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const workspacePaths = yield* WorkspacePaths.make;
      return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodePath.layerWin32,
          FileSystem.layerNoop({
            stat: (path) =>
              path === existing
                ? Effect.succeed({ type: "Directory" } as FileSystem.File.Info)
                : Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "stat",
                      pathOrDescriptor: path,
                    }),
                  ),
          }),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.HomeDirectory, "C:\\Users\\super"),
    );

  it.effect.each([
    "/c/Users/super/Developer/goat",
    "/C/Users/super/Developer/goat/",
    "/cygdrive/c/Users/super/Developer/goat",
    "C:/Users/super/Developer/goat",
    "~/Developer/goat",
  ])("maps %s to the native folder", (workspaceRoot) =>
    Effect.gen(function* () {
      expect(yield* normalizeOnWindows(workspaceRoot)).toBe(existing);
    }),
  );

  it("leaves the shell form alone on other platforms", () => {
    expect(WorkspacePaths.nativeWorkspacePath("linux", "/c/Users/x")).toBe("/c/Users/x");
    expect(WorkspacePaths.nativeWorkspacePath("darwin", "/cygdrive/c/x")).toBe("/cygdrive/c/x");
    expect(WorkspacePaths.nativeWorkspacePath("win32", "\\\\server\\share")).toBe(
      "\\\\server\\share",
    );
  });
});

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "goat-project-paths-",
  });
});

it.layer(layerTest)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(missingPath);
        expect(stat.type).toBe("Directory");
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});
