// @effect-diagnostics nodeBuiltinImport:off - directory entries in shared pnpm stores need type information.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

class WorktreeDirectoryReadError extends Schema.TaggedError<WorktreeDirectoryReadError>()(
  "WorktreeDirectoryReadError",
  { cause: Schema.Defect() },
) {}

export const makeWorktreeMeasurement = (input: {
  fs: FileSystem.FileSystem;
  path: Path.Path;
  git: GitVcsDriver.GitVcsDriver["Service"];
  pathKey: (target: string) => string;
  inside: (root: string, target: string) => boolean;
  sharedPnpmVirtualStore: (root: string) => Effect.Effect<string | null>;
}) => {
  const { fs, path, git, pathKey, inside, sharedPnpmVirtualStore } = input;
  return Effect.fn("storageCleanup.measureWorktree")(
    function* (worktreePath: string, inspectRepositories = false) {
      const root = yield* fs.realPath(worktreePath);
      const skipped = yield* sharedPnpmVirtualStore(root);
      const incomplete = { bytes: null, reason: "worktree could not be fully inspected" };
      const repositories = new Set([pathKey(root)]);
      const moduleStores: string[] = [];
      if (inspectRepositories && (yield* fs.exists(path.join(root, ".gitmodules")))) {
        const submodules = yield* git.execute({
          operation: "StorageCleanup.nestedRepositories",
          cwd: root,
          args: [
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            'printf "%s\\0" "$toplevel/$sm_path"',
          ],
          maxOutputBytes: 64 * 1024,
        });
        if (submodules.stdoutTruncated || submodules.stderrTruncated) return incomplete;
        for (const submodule of submodules.stdout.split("\0").filter(Boolean)) {
          repositories.add(pathKey(path.resolve(submodule)));
          repositories.add(pathKey(path.resolve(submodule, ".git")));
          moduleStores.push(pathKey(path.resolve(submodule, ".git", "modules")));
        }
      }
      const isNestedRepository = (target: string, names: ReadonlyArray<string>) => {
        const key = pathKey(target);
        if (
          repositories.has(key) ||
          moduleStores.some((store) => key === store || inside(store, key))
        )
          return false;
        const markers = new Set(names.map((name) => name.toLowerCase()));
        return (
          markers.has(".git") ||
          (markers.has("head") && markers.has("objects") && markers.has("refs"))
        );
      };
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const inspected = yield* Effect.forEach(
          pending.splice(-8),
          // A worktree can contain millions of entries; per-entry spans would overwhelm tracing.
          Effect.fnUntraced(function* (target) {
            const empty = { target, bytes: 0, names: [] as string[], children: [] as string[] };
            const inStore = skipped !== null && (target === skipped || inside(skipped, target));
            if (inStore && !inspectRepositories) return empty;
            const isLink = yield* fs.readLink(target).pipe(
              Effect.as(true),
              Effect.catchIf(
                (error) =>
                  error.cause instanceof Error &&
                  "code" in error.cause &&
                  error.cause.code === "EINVAL",
                () => Effect.succeed(false),
              ),
            );
            if (isLink) return empty;
            if ((yield* fs.realPath(target)) !== target) return null;
            const stat = yield* fs.stat(target);
            if (stat.type === "Directory") {
              if (!inStore) {
                const names = yield* fs.readDirectory(target);
                return { target, bytes: 0, names, children: names };
              }
              const dirents = yield* Effect.tryPromise({
                try: () => NodeFSP.readdir(target, { withFileTypes: true }),
                catch: (cause) => new WorktreeDirectoryReadError({ cause }),
              });
              return {
                target,
                bytes: 0,
                names: dirents.map((entry) => entry.name),
                children: dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
              };
            }
            if (stat.type !== "File" || Option.getOrElse(stat.nlink, () => 1n) !== 1n) return empty;
            const bytes = Option.match(stat.blocks, {
              onNone: () => Number(stat.size),
              onSome: (blocks) => Number(blocks * 512n),
            });
            return { ...empty, bytes };
          }),
          { concurrency: 8 },
        );
        for (const result of inspected) {
          if (result === null) return incomplete;
          if (inspectRepositories && isNestedRepository(result.target, result.names))
            return { bytes: null, reason: "contains a nested Git repository" };
          bytes += result.bytes;
          entries += result.names.length;
          if (entries > 2_000_000) return incomplete;
          for (const name of result.children) {
            const child = path.join(result.target, name);
            if (!inside(root, child)) return incomplete;
            pending.push(child);
          }
        }
      }
      return { bytes, reason: null };
    },
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => ({ bytes: null, reason: "worktree could not be fully inspected" })),
  );
};
