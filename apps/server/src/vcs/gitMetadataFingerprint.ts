import * as NodeCrypto from "node:crypto";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { detachStackFrame } from "../git/detachStackFrame.ts";

const BRANCH_SECTION_HEADER = /^\s*\[branch\s+"((?:[^"\\]|\\.)*)"\]\s*$/i;
const CONFIG_SECTION_MEMO_CAPACITY = 256;

const digest = (text: string) => NodeCrypto.createHash("sha1").update(text).digest("hex");

/**
 * Splits a git config into the text outside exact `[branch "<name>"]` sections and each such
 * section's text. Returns null when a line continues onto the next one, since a continued value
 * can look like a header; callers then fall back to stamping the whole file.
 */
export function splitBranchSections(
  text: string,
): { readonly shared: string; readonly branches: ReadonlyMap<string, string> } | null {
  const shared: string[] = [];
  const branches = new Map<string, string[]>();
  let target = shared;
  for (const line of text.split(/\r?\n/)) {
    if (line.endsWith("\\")) return null;
    // Blank lines carry nothing, and the file's last one would move with every appended section.
    if (line.trim().length === 0) continue;
    if (/^\s*\[/.test(line)) {
      const name = BRANCH_SECTION_HEADER.exec(line)?.[1]?.replace(/\\(.)/g, "$1");
      if (name !== undefined) {
        target = branches.get(name) ?? [];
        branches.set(name, target);
        continue;
      }
      target = shared;
    }
    target.push(line);
  }
  return {
    shared: digest(shared.join("\n")),
    branches: new Map([...branches].map(([name, lines]) => [name, digest(lines.join("\n"))])),
  };
}

// Gitfiles and commondir make linked worktrees share config while keeping their own HEAD.
// Unknown layouts or inaccessible metadata disable reuse; git remains authoritative.
// A branch-scoped read leaves other branches' config sections out: a repository with many
// worktrees rewrites its shared config whenever any of them publishes a branch.
export const makeGitMetadataFingerprint = Effect.fn("GitMetadataFingerprint.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The outer read span owns validation; tracing every stat would multiply hot-path spans.
  const stamp = Effect.fnUntraced(function* (file: string) {
    return yield* fs.stat(file).pipe(
      Effect.map(
        (info) =>
          `${Option.getOrNull(info.ino)}:${info.size}:${Option.getOrNull(info.mtime)?.getTime()}`,
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("missing")),
    );
  });
  const sectionsByConfig = new Map<
    string,
    { readonly stamp: string; readonly sections: ReturnType<typeof splitBranchSections> }
  >();
  // Parses only when the file's stamp moves, so steady lookups cost one stat as before.
  const configSections = Effect.fnUntraced(function* (file: string, fileStamp: string) {
    const memo = sectionsByConfig.get(file);
    if (memo?.stamp === fileStamp) return memo.sections;
    const sections =
      fileStamp === "missing"
        ? null
        : yield* fs.readFileString(file).pipe(
            Effect.map(splitBranchSections),
            Effect.orElseSucceed(() => null),
          );
    sectionsByConfig.delete(file);
    if (sectionsByConfig.size >= CONFIG_SECTION_MEMO_CAPACITY) {
      const oldest = sectionsByConfig.keys().next().value;
      if (oldest !== undefined) sectionsByConfig.delete(oldest);
    }
    sectionsByConfig.set(file, { stamp: fileStamp, sections });
    return sections;
  });
  const directories = yield* Cache.makeWith(
    (cwd: string) =>
      Effect.gen(function* () {
        let root = yield* fs.realPath(path.resolve(cwd));
        while (true) {
          const candidate = path.join(root, ".git");
          const info = yield* fs.stat(candidate).pipe(
            Effect.map(Option.some),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
          );
          if (Option.isSome(info)) {
            const gitDir =
              info.value.type === "Directory"
                ? candidate
                : path.resolve(
                    root,
                    (yield* fs.readFileString(candidate)).replace(/^gitdir: /, "").trim(),
                  );
            const common = yield* fs
              .readFileString(path.join(gitDir, "commondir"))
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(".")));
            return { root, gitDir, commonDir: path.resolve(gitDir, common.trim()) };
          }
          const parent = path.dirname(root);
          if (parent === root) return null;
          root = parent;
        }
      }).pipe(Effect.orElseSucceed(() => null)),
    {
      capacity: 2048,
      timeToLive: (exit) =>
        exit._tag === "Success" && exit.value !== null ? "1 second" : "0 seconds",
    },
  );
  return Effect.fn("GitMetadataFingerprint.read")(
    function* (cwd: string, branch?: string) {
      const dirs = yield* detachStackFrame(Cache.get(directories, path.resolve(cwd)));
      if (dirs === null) return null;
      const configFile = path.join(dirs.commonDir, "config");
      const repositoryFiles = [
        path.join(dirs.gitDir, "HEAD"),
        path.join(dirs.gitDir, "config.worktree"),
        configFile,
      ];
      // Remote-tracking refs change on fetch and push without touching the branch or config.
      const remotes =
        branch === undefined
          ? []
          : yield* fs
              .readDirectory(path.join(dirs.commonDir, "refs", "remotes"))
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
      const refFiles =
        branch === undefined
          ? []
          : [
              path.join(dirs.commonDir, "packed-refs"),
              path.join(dirs.commonDir, "reftable", "tables.list"),
              path.join(dirs.commonDir, "refs", "heads", branch),
              ...remotes
                .toSorted()
                .flatMap((remote) => [
                  path.join(dirs.commonDir, "refs", "remotes", remote, branch),
                  path.join(dirs.commonDir, "refs", "remotes", remote, "HEAD"),
                ]),
            ];
      const stamps = yield* Effect.forEach([...repositoryFiles, ...refFiles], stamp, {
        concurrency: "unbounded",
      });
      const repositoryStamps = stamps.slice(0, repositoryFiles.length);
      const refStamps = stamps.slice(repositoryFiles.length);
      const configIndex = repositoryFiles.length - 1;
      const sections =
        branch === undefined
          ? null
          : yield* configSections(configFile, repositoryStamps[configIndex] ?? "missing");
      if (branch !== undefined && sections !== null) {
        repositoryStamps[configIndex] = `shared:${sections.shared}`;
        refStamps.push(`branch:${sections.branches.get(branch) ?? "none"}`);
      }
      return {
        root: dirs.root,
        repository: `${dirs.gitDir}\u0000${repositoryStamps.join("\u0000")}`,
        refs: refStamps.join("\u0000"),
      };
    },
    Effect.orElseSucceed(() => null),
  );
});
