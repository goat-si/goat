import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

// Git status skips assume-unchanged and skip-worktree files, so only the snapshot step sees them.
it.live.each(["--assume-unchanged", "--skip-worktree"] as const)(
  "keeps tracked edits that git status hides (%s)",
  (flag) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* cleanupFixture();
        yield* command(worktree, ["update-index", flag, "tracked.txt"]);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "hidden edit\n");
        expect((yield* service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("hidden from git status (tracked.txt)"),
        });
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("hidden edit\n");
      }),
    ),
);

it.live("removes worktrees whose flagged files are unchanged or outside a sparse checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, command } = yield* cleanupFixture();
      yield* command(worktree, ["update-index", "--skip-worktree", "tracked.txt"]);
      yield* fs.remove(`${worktree}/tracked.txt`);
      yield* command(worktree, ["update-index", "--assume-unchanged", ".gitignore"]);
      expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
    }),
  ),
);

it.live.each([
  ["missing", "symlink"],
  ["tracked.txt", "symlink"],
  ["missing", "file"],
  ["tracked.txt", "file"],
] as const)("compares flagged tracked symlinks by target (%s as a %s)", ([target, kind]) =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, command, repo } = yield* cleanupFixture();
      yield* fs.symlink("tracked.txt", `${worktree}/link`);
      yield* command(worktree, ["add", "link"]);
      yield* command(worktree, ["commit", "-m", "link"]);
      // Shipped, so only the flagged link decides whether cleanup may remove the worktree.
      yield* command(repo, ["merge", "--ff-only", "feature"]);
      yield* command(worktree, ["update-index", "--assume-unchanged", "link"]);
      yield* fs.remove(`${worktree}/link`);
      // Without core.symlinks, Git checks a link out as a regular file holding its target.
      if (kind === "file") {
        yield* command(worktree, ["config", "core.symlinks", "false"]);
        yield* fs.writeFileString(`${worktree}/link`, target);
      } else yield* fs.symlink(target, `${worktree}/link`);
      expect((yield* service.runNow).entries[0]).toMatchObject(
        target === "missing"
          ? { outcome: "kept", reason: expect.stringContaining("(link)") }
          : { outcome: "removed" },
      );
    }),
  ),
);

// A sparse checkout leaves files outside its patterns skip-worktree; with
// sparse.expectFilesOutsideOfPatterns (or Git before 2.37) an edit there stays flagged and unseen.
const sparseWorktree = (edit: string | null) =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture();
    const { fs, worktree, command } = fixture;
    yield* command(worktree, ["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
    yield* command(worktree, ["sparse-checkout", "set", "--no-cone", "/.gitignore"]);
    expect(yield* fs.exists(`${worktree}/tracked.txt`)).toBe(false);
    if (edit !== null) yield* fs.writeFileString(`${worktree}/tracked.txt`, edit);
    // Git status does not show it, which is why the snapshot step must.
    const status = (yield* command(worktree, ["status", "--porcelain"])).stdout;
    return { ...fixture, status, report: yield* fixture.service.runNow };
  });

it.live("keeps an edit to a tracked file outside a sparse checkout's patterns", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { fs, worktree, status, report } = yield* sparseWorktree("hidden edit\n");
      expect(status).toBe("");
      expect(report.entries[0]).toMatchObject({
        outcome: "kept",
        reason: expect.stringContaining("hidden from git status (tracked.txt)"),
      });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("hidden edit\n");
    }),
  ),
);

it.live("removes a sparse worktree whose files outside its patterns are not on disk", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { report } = yield* sparseWorktree(null);
      expect(report.entries[0]).toMatchObject({ outcome: "removed" });
    }),
  ),
);
// A name holding a newline cannot be handed back to Git, so an edit to it counts as one; outside
// the sparse patterns it is usually not on disk, which is no edit at all.
it.live.each([
  ["not on disk", "removed", null],
  ["edited", "kept", "hidden edit\n"],
] as const)(
  "a flagged name with a newline outside a sparse checkout's patterns, %s, is %s",
  ([, outcome, edit]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        const { fs, repo, worktree, command } = fixture;
        const name = "line\nbreak.txt";
        yield* fs.writeFileString(`${worktree}/${name}`, "original\n");
        yield* command(worktree, ["add", "--", name]);
        yield* command(worktree, ["commit", "-m", "a name with a newline"]);
        // The commit is on the default branch too, so only the hidden check can keep the worktree.
        yield* command(repo, ["update-ref", "refs/heads/main", "refs/heads/feature"]);
        yield* command(worktree, ["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
        yield* command(worktree, ["sparse-checkout", "set", "--no-cone", "/.gitignore"]);
        expect(yield* fs.exists(`${worktree}/${name}`)).toBe(false);
        if (edit !== null) yield* fs.writeFileString(`${worktree}/${name}`, edit);
        expect((yield* fixture.service.runNow).entries[0]).toMatchObject({ outcome });
      }),
    ),
);
