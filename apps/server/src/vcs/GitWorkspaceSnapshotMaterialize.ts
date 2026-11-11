import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as VcsDriver from "./VcsDriver.ts";

export class GitWorkspaceSnapshotMaterializeError extends Schema.TaggedError<GitWorkspaceSnapshotMaterializeError>()(
  "GitWorkspaceSnapshotMaterializeError",
  {
    reason: Schema.Literals(["path_list_incomplete", "restore_failed", "verify_failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface MaterializeWorkspaceSnapshotInput {
  /** A checkout of baseCommit whose HEAD and index stay as they are. */
  readonly cwd: string;
  readonly baseCommit: string;
  readonly snapshotCommit: string;
}

export interface MaterializeDeps {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

interface ChangedEntry {
  readonly path: string;
  /** 000000 when the snapshot deleted the path. */
  readonly mode: string;
  readonly oid: string;
}

const DIFF_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const HASH_BATCH = 200;
const operation = "GitVcsDriver.materializeWorkspaceSnapshot";

const fail = (
  reason: GitWorkspaceSnapshotMaterializeError["reason"],
  detail: string,
  cause?: unknown,
) =>
  new GitWorkspaceSnapshotMaterializeError({
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/** Parses `git diff --raw -z --no-renames`: ":<old> <new> <oldOid> <newOid> <status>\0<path>\0". */
function parseRawDiff(stdout: string): ReadonlyArray<ChangedEntry> | null {
  const fields = stdout.split("\0");
  const entries: ChangedEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    if (header === undefined || path === undefined || path === "") return null;
    const [, mode, , oid] = header.slice(1).split(" ");
    if (!header.startsWith(":") || mode === undefined || oid === undefined) return null;
    entries.push({ path, mode, oid });
  }
  return entries;
}

/**
 * Writes the files a workspace snapshot changed relative to its base into a checkout of that base,
 * leaving HEAD and the index alone, then checks every written file by content and mode.
 */
export const materializeWorkspaceSnapshot = Effect.fn("GitVcsDriver.materializeWorkspaceSnapshot")(
  function* (deps: MaterializeDeps, input: MaterializeWorkspaceSnapshotInput) {
    const { execute, fileSystem, path } = deps;
    const diff = yield* execute({
      operation,
      cwd: input.cwd,
      args: [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-abbrev",
        "--no-ext-diff",
        input.baseCommit,
        input.snapshotCommit,
      ],
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
    }).pipe(Effect.mapError((cause) => fail("path_list_incomplete", "git diff failed", cause)));
    // A name that is not UTF-8 cannot round-trip through a string pathspec, and a cut list is incomplete.
    if (diff.stdoutTruncated || diff.stdoutInvalidUtf8 === true) {
      return yield* fail("path_list_incomplete", "The changed-path list could not be read whole.");
    }
    const entries = parseRawDiff(diff.stdout);
    if (entries === null) {
      return yield* fail("path_list_incomplete", "The changed-path list could not be parsed.");
    }
    if (entries.length === 0) return { changedPaths: 0 };

    yield* execute({
      operation,
      cwd: input.cwd,
      args: [
        // A file named like pathspec magic must select only itself.
        "--literal-pathspecs",
        "restore",
        `--source=${input.snapshotCommit}`,
        "--worktree",
        // New worktrees carry the project's sparse exclusions; changed files under them still belong.
        "--ignore-skip-worktree-bits",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      stdin: entries.map((entry) => entry.path).join("\0") + "\0",
    }).pipe(Effect.mapError((cause) => fail("restore_failed", "git restore failed", cause)));

    const files = entries.filter((entry) => entry.mode === "100644" || entry.mode === "100755");
    for (let start = 0; start < files.length; start += HASH_BATCH) {
      const batch = files.slice(start, start + HASH_BATCH);
      // Without --no-filters Git hashes each file as `git add` would store it.
      const hashed = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["hash-object", "--", ...batch.map((entry) => entry.path)],
      }).pipe(Effect.mapError((cause) => fail("verify_failed", "git hash-object failed", cause)));
      const oids = hashed.stdout.trim().split("\n");
      for (const [index, entry] of batch.entries()) {
        if (oids[index] !== entry.oid) {
          return yield* fail("verify_failed", `${entry.path} does not match the snapshot.`);
        }
        const info = yield* fileSystem
          .stat(path.join(input.cwd, entry.path))
          .pipe(
            Effect.mapError((cause) => fail("verify_failed", `${entry.path} is missing.`, cause)),
          );
        const executable = (info.mode & 0o111) !== 0;
        if (executable !== (entry.mode === "100755")) {
          return yield* fail("verify_failed", `${entry.path} has the wrong executable bit.`);
        }
      }
    }
    for (const entry of entries) {
      const target = path.join(input.cwd, entry.path);
      if (entry.mode === "000000") {
        const present =
          (yield* fileSystem.readLink(target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )) || (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true)));
        if (present) return yield* fail("verify_failed", `${entry.path} should be deleted.`);
      } else if (entry.mode === "120000") {
        const link = yield* fileSystem
          .readLink(target)
          .pipe(
            Effect.mapError((cause) =>
              fail("verify_failed", `${entry.path} is not a link.`, cause),
            ),
          );
        const expected = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["cat-file", "blob", entry.oid],
        }).pipe(Effect.mapError((cause) => fail("verify_failed", "git cat-file failed", cause)));
        if (link !== expected.stdout) {
          return yield* fail("verify_failed", `${entry.path} points elsewhere than the snapshot.`);
        }
      } else if (entry.mode !== "100644" && entry.mode !== "100755") {
        return yield* fail("verify_failed", `${entry.path} has an unsupported mode ${entry.mode}.`);
      }
    }
    return { changedPaths: entries.length };
  },
);
