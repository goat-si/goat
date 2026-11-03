import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { detachStackFrame } from "../git/detachStackFrame.ts";

const BRANCH_SECTION_HEADER = /^\s*\[branch\s+"((?:[^"\\]|\\.)*)"\]\s*(?:[#;].*)?$/i;
const PLAIN_SECTION_HEADER = /^\s*\[[A-Za-z0-9.-]+(?:\s+"(?:[^"\\]|\\.)*")?\]\s*$/;
// Includes and legacy [branch.x] headers can set a branch's values from outside its own section.
const ORDER_SENSITIVE_SECTION = /^\s*\[\s*(?:include|includeif|branch\s*\.)/i;
const CONFIG_SECTION_MEMO_CAPACITY = 256;
const CONFIG_SECTION_MAX_BYTES = 256 * 1024;
// FAT/exFAT mtimes have two-second resolution; network filesystems may be coarser.
const CONFIG_MTIME_GRANULARITY_MS = 2_000;

/**
 * Splits a git config into the text outside exact \`[branch "<name>"]\` sections and each such
 * section's text. Returns null whenever a value or section outside the branch's own section could
 * still change it (continued values, includes, legacy or inline headers); callers then stamp the
 * whole file.
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
      if (ORDER_SENSITIVE_SECTION.test(line) || !PLAIN_SECTION_HEADER.test(line)) return null;
      target = shared;
    }
    target.push(line);
  }
  return {
    shared: shared.join("\n"),
    branches: new Map([...branches].map(([name, lines]) => [name, lines.join("\n")])),
  };
}

// Gitfiles and commondir make linked worktrees share config while keeping their own HEAD.
// Unknown layouts or inaccessible metadata disable reuse; git remains authoritative.
// A branch-scoped read leaves other branches' config sections out: a repository with many
// worktrees rewrites its shared config whenever any of them publishes a branch.
export const makeGitMetadataFingerprint = Effect.fn("GitMetadataFingerprint.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // The outer read span owns validation; tracing every stat would multiply hot-path spans.
  const stamp = Effect.fnUntraced(function* (file: string) {
    return yield* fs.stat(file).pipe(
      Effect.map((info) => ({
        value: `${Option.getOrNull(info.ino)}:${info.size}:${Option.getOrNull(info.mtime)?.getTime()}`,
        mtime: Option.getOrNull(info.mtime)?.getTime() ?? null,
      })),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed({ value: "missing", mtime: null }),
      ),
    );
  });
  // Reads at most the cap even if the file grows while it is read; null means stamp the whole file.
  const readBounded = Effect.fnUntraced(
    function* (file: string) {
      const handle = yield* fs.open(file, { flag: "r" });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (bytes <= CONFIG_SECTION_MAX_BYTES) {
        const chunk = yield* handle.readAlloc(64 * 1024);
        if (Option.isNone(chunk)) {
          const result = new Uint8Array(bytes);
          let offset = 0;
          for (const part of chunks) {
            result.set(part, offset);
            offset += part.length;
          }
          return result;
        }
        bytes += chunk.value.length;
        chunks.push(chunk.value);
      }
      return null;
    },
    Effect.scoped,
    Effect.orElseSucceed(() => null),
  );
  const sectionsByConfig = new Map<
    string,
    {
      readonly stamp: string;
      readonly reusable: boolean;
      readonly sections: ReturnType<typeof splitBranchSections>;
      readonly fallback: string;
    }
  >();
  let racyRead = 0;
  const configSections = Effect.fnUntraced(function* (
    file: string,
    fileStamp: { value: string; mtime: number | null },
  ) {
    const memo = sectionsByConfig.get(file);
    if (memo?.stamp === fileStamp.value && memo.reusable) return memo;
    const readAt = yield* Clock.currentTimeMillis;
    const bytes = fileStamp.value === "missing" ? null : yield* readBounded(file);
    const text =
      bytes === null
        ? null
        : yield* Effect.try(() =>
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          ).pipe(Effect.orElseSucceed(() => null));
    const sections = text === null ? null : splitBranchSections(text);
    const reusable =
      fileStamp.value === "missing" ||
      (fileStamp.mtime !== null && readAt - fileStamp.mtime > CONFIG_MTIME_GRANULARITY_MS);
    const fallback =
      bytes !== null && sections === null
        ? `${fileStamp.value}:content:${Hex.encode(yield* crypto.digest("SHA-256", bytes))}`
        : !reusable && bytes === null
          ? `${fileStamp.value}:racy:${++racyRead}`
          : fileStamp.value;
    sectionsByConfig.delete(file);
    if (sectionsByConfig.size >= CONFIG_SECTION_MEMO_CAPACITY) {
      const oldest = sectionsByConfig.keys().next().value;
      if (oldest !== undefined) sectionsByConfig.delete(oldest);
    }
    const entry = {
      stamp: fileStamp.value,
      reusable,
      sections,
      fallback,
    };
    sectionsByConfig.set(file, entry);
    return entry;
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
      const repositoryStamps = stamps.slice(0, repositoryFiles.length).map((entry) => entry.value);
      const refStamps = stamps.slice(repositoryFiles.length).map((entry) => entry.value);
      const configIndex = repositoryFiles.length - 1;
      const config =
        branch === undefined
          ? null
          : yield* configSections(
              configFile,
              stamps[configIndex] ?? { value: "missing", mtime: null },
            );
      if (branch !== undefined && config !== null) {
        if (config.sections !== null) {
          repositoryStamps[configIndex] = `shared:${config.sections.shared}`;
          refStamps.push(`branch:${config.sections.branches.get(branch) ?? "none"}`);
        } else {
          repositoryStamps[configIndex] = config.fallback;
        }
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
