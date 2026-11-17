// @effect-diagnostics nodeBuiltinImport:off - links must be read without following them.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { WorktreeSnapshotError } from "./WorktreeSnapshotStore.ts";

const notFound = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

/**
 * The first assume-unchanged or skip-worktree file whose content on disk differs from the index.
 * Git status and the snapshot's own `git add` skip these files, so such an edit would be lost.
 * A file missing on disk is no edit a snapshot could keep; a name Git cannot round-trip counts.
 */
export const hiddenTrackedChange = Effect.fn("WorktreeSnapshot.hiddenTrackedChange")(function* (
  cwd: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const fail = (detail: string, cause?: unknown) =>
    new WorktreeSnapshotError({ worktreePath: cwd, detail, cause });
  const run = Effect.fn("WorktreeSnapshot.hiddenTrackedChange.git")(function* (
    args: string[],
    stdin?: string,
  ) {
    const result = yield* git.execute({
      operation: "WorktreeSnapshot.hiddenTrackedChange",
      cwd,
      args,
      ...(stdin === undefined ? {} : { stdin }),
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.stdoutTruncated) return yield* fail("Git output exceeded snapshot inspection limit");
    return result.stdout;
  });
  // Skip-worktree counts in sparse checkouts too: Git before 2.37, or with
  // sparse.expectFilesOutsideOfPatterns, keeps an edited file outside the patterns flagged. Files
  // outside the patterns that are not on disk are skipped below, one lstat each.
  const hiddenTag = /^(?:S|[a-z])$/;
  const flagged = (yield* run(["ls-files", "-s", "-v", "-z"])).split("\0").flatMap((record) => {
    const [, tag = "", mode = "", id = "", file = ""] =
      /^(\S) (\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(record) ?? [];
    return hiddenTag.test(tag) && mode !== "160000" ? [{ mode, id, file }] : [];
  });
  // Names that are not valid UTF-8, or hold a newline, cannot be handed back to Git to hash.
  const unreadable = flagged.find(({ file }) => file.includes("\uFFFD") || file.includes("\n"));
  if (unreadable !== undefined) return unreadable.file;
  const files: Array<(typeof flagged)[number]> = [];
  // Without core.symlinks a tracked link is a regular file holding its target, compared unfiltered.
  const linkFiles: Array<(typeof flagged)[number]> = [];
  for (const entry of flagged) {
    const target = path.join(cwd, entry.file);
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(target),
      catch: (cause) => fail("cannot inspect a file hidden from git status", cause),
    }).pipe(
      Effect.catchIf(
        (error) => notFound(error.cause),
        () => Effect.succeed(null),
      ),
    );
    if (stat === null) continue;
    if (stat.isFile()) (entry.mode === "120000" ? linkFiles : files).push(entry);
    else if (!stat.isSymbolicLink() || entry.mode !== "120000") return entry.file;
    else {
      const link = yield* Effect.tryPromise({
        try: () => NodeFSP.readlink(target),
        catch: (cause) => fail("cannot read a link hidden from git status", cause),
      });
      // Hashing a link's path would hash the file it points to.
      if ((yield* run(["hash-object", "--stdin"], link)).trim() !== entry.id) return entry.file;
    }
  }
  const hashPaths = (entries: ReadonlyArray<{ readonly file: string }>, flags: string[]) =>
    entries.length === 0
      ? Effect.succeed([])
      : run(
          ["hash-object", ...flags, "--stdin-paths"],
          entries.map(({ file }) => `${file}\n`).join(""),
        ).pipe(Effect.map((stdout) => stdout.split("\n")));
  const fileIds = yield* hashPaths(files, []);
  const linkIds = yield* hashPaths(linkFiles, ["--no-filters"]);
  const changed =
    files.find(({ id }, index) => fileIds[index] !== id) ??
    linkFiles.find(({ id }, index) => linkIds[index] !== id);
  return changed?.file ?? null;
});
