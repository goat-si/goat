// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, describe, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "goat-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "goat-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

// Symlink cases of WorkspaceEntries.test.ts, here because that file is near its line cap.
it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries symlinks", (it) => {
  it.effect("evicts the oldest idle finder and refuses overflow while all slots are borrowed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir();
      const roots = Array.from({ length: 17 }, (_, index) => path.join(cwd, `repo-${index}`));
      const created = new Set<string>();
      const destroyed: string[] = [];
      const allBorrowed = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      let held = 0;
      const empty = { ok: true as const, value: { items: [], totalMatched: 0 } };
      using _create = vi.spyOn(FileFinder, "create").mockImplementation(({ basePath }) => {
        created.add(basePath);
        return {
          ok: true,
          value: {
            destroyAsync: async () => {
              destroyed.push(basePath);
            },
            waitForIndexReady: async () => ({ ok: true, value: true }),
            getScanProgressAsync: async () => ({ ok: true, value: { isScanning: false } }),
            watchAsync: async () => ({ ok: true, value: () => {} }),
            directorySearchAsync: async () => empty,
            fileSearchAsync: async (query: string) => {
              if (query === "hold") {
                held += 1;
                if (held === 16) Deferred.doneUnsafe(allBorrowed, Effect.void);
                await release.promise;
              }
              return empty;
            },
          } as unknown as FileFinder,
        };
      });
      const search = (cwd: string, query = "probe") =>
        searchWorkspaceEntries({ cwd, query, kind: "file", limit: 10 });
      for (const root of roots) yield* fs.makeDirectory(root);
      for (const root of roots.slice(0, 16)) yield* search(root);
      const first = path.join(cwd, "repo-0");
      const second = path.join(cwd, "repo-1");
      yield* search(first);
      yield* search(path.join(cwd, "repo-16"));
      expect(destroyed).toEqual([second]);
      expect(created.size).toBe(17);

      const retained = roots.filter((root) => root !== second);
      const readers = yield* Effect.forEach(retained, (root) => search(root, "hold"), {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      try {
        yield* Deferred.await(allBorrowed);
        const overflow = yield* search(second).pipe(Effect.flip);
        expect(overflow._tag).toBe("WorkspaceSearchIndexCreateFailed");
        expect(destroyed).toEqual([second]);
      } finally {
        release.resolve();
      }
      yield* Fiber.join(readers);
    }),
  );

  describe("search", () => {
    it.effect("checks canonical containment for exact matches in a newline-named worktree", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ git: true });
        const outside = yield* makeTempDir();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, ".gitignore", ".worktrees/\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
        const worktree = ".worktrees/line\nname";
        yield* git(cwd, ["worktree", "add", "--detach", worktree]);
        yield* writeTextFile(outside, "outside.txt");
        yield* writeTextFile(cwd, "fixtures/inside.txt");
        yield* fs.symlink(outside, path.join(cwd, worktree, "external"));
        yield* fs.symlink(path.join(cwd, "fixtures"), path.join(cwd, worktree, "internal"));
        const search = (query: string) => searchWorkspaceEntries({ cwd, query, limit: 25 });

        expect((yield* search("external/outside.txt")).entries).not.toContainEqual({
          kind: "file",
          path: `${worktree}/external/outside.txt`,
        });
        expect((yield* search("internal/inside.txt")).entries).toContainEqual({
          kind: "file",
          path: `${worktree}/internal/inside.txt`,
        });
      }),
    );
    it.effect("indexes symlinked files and directories inside the workspace", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "goat-workspace-symlinks-" });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "src/index.ts", "export {};");
        yield* fileSystem.symlink("src", path.join(cwd, "src-link"));
        yield* fileSystem.symlink("src/index.ts", path.join(cwd, "index-link.ts"));
        const symlinkEntries = [
          { kind: "directory", path: "src-link" },
          { kind: "file", path: "index-link.ts" },
        ];

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entry of symlinkEntries) {
          expect(searched.entries).toContainEqual(expect.objectContaining(entry));
          expect(listed.entries).toContainEqual(expect.objectContaining(entry));
        }
      }),
    );
    it.effect("skips symlinks that ignore rules hide or that leave the workspace", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "goat-workspace-symlinks-", git: true });
        const outside = yield* makeTempDir({ prefix: "goat-workspace-symlinks-outside-" });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "src/index.ts", "export {};");
        yield* writeTextFile(cwd, ".ignore", "custom-link\n");
        yield* fileSystem.symlink("src", path.join(cwd, "custom-link"));
        yield* fileSystem.symlink("src/index.ts", path.join(cwd, "tracked-link.ts"));
        yield* fileSystem.symlink("src", path.join(cwd, "ignored-link"));
        yield* fileSystem.symlink("src", path.join(cwd, "kept-link"));
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));
        yield* git(cwd, ["add", "tracked-link.ts"]);
        yield* writeTextFile(cwd, ".gitignore", "tracked-link.ts\nignored-link\n");
        // A submodule path makes `git check-ignore` refuse the whole batch without --no-index.
        const submodule = path.join(cwd, "vendor/sub");
        yield* writeTextFile(submodule, "a.ts", "export {};");
        yield* git(submodule, ["init"]);
        yield* git(submodule, ["add", "a.ts"]);
        yield* git(submodule, [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "-m",
          "init",
        ]);
        yield* git(cwd, ["add", "vendor/sub"]);
        yield* fileSystem.symlink("a.ts", path.join(submodule, "sublink.ts"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entries of [searched.entries, listed.entries]) {
          const paths = entries.map((entry) => entry.path);
          expect(paths).toContain("kept-link");
          expect(paths).toContain("vendor/sub/sublink.ts");
          expect(paths).not.toContain("custom-link");
          expect(paths).not.toContain("tracked-link.ts");
          expect(paths).not.toContain("ignored-link");
          expect(paths).not.toContain("outside-link");
        }
      }),
    );
    it.effect("lets the nearest .ignore rule decide a symlink, ahead of git's rules", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "goat-workspace-symlinks-", git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, ".gitignore", "*keep*\n");
        yield* writeTextFile(cwd, ".ignore", "!*keep*\n*hide*\n");
        yield* writeTextFile(cwd, "sub/.ignore", "!*hide*\n");
        yield* writeTextFile(cwd, "keep-real.ts", "export {};");
        yield* writeTextFile(cwd, "sub/hide-real.ts", "export {};");
        yield* fileSystem.symlink("keep-real.ts", path.join(cwd, "keep-link.ts"));
        yield* fileSystem.symlink("hide-real.ts", path.join(cwd, "sub/hide-link.ts"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entries of [searched.entries, listed.entries]) {
          const paths = entries.map((entry) => entry.path);
          expect(paths).toContain("sub/hide-link.ts");
          expect(paths).toContain("keep-link.ts");
        }
        // The real files are shown or hidden by the same rules.
        const listedPaths = listed.entries.map((entry) => entry.path);
        expect(listedPaths).toContain("sub/hide-real.ts");
        expect(listedPaths).toContain("keep-real.ts");
      }),
    );
    it.effect("matches .ignore rules against whole names and treats folder links as links", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const cwd = yield* makeTempDir({ prefix: "goat-workspace-symlinks-", git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "src/index.ts", "export {};");
        yield* writeTextFile(cwd, ".gitignore", "blink\n");
        // `!link` must not re-include `blink`, and `folder-link/` does not apply to a link.
        yield* writeTextFile(cwd, ".ignore", "!link\nfolder-link/\n");
        yield* fileSystem.symlink("src", path.join(cwd, "blink"));
        yield* fileSystem.symlink("src", path.join(cwd, "folder-link"));
        yield* writeTextFile(cwd, "sub/blink", "regular");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const searched = yield* searchWorkspaceEntries({ cwd, query: "link", limit: 100 });
        const listed = yield* workspaceEntries.list({ cwd });

        for (const entries of [searched.entries, listed.entries]) {
          const paths = entries.map((entry) => entry.path);
          expect(paths).not.toContain("blink");
          expect(paths).not.toContain("sub/blink");
          expect(paths).toContain("folder-link");
        }
      }),
    );
  });
});
