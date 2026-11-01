import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitVcs from "../vcs/GitVcsDriver.ts";
import * as CloudSource from "./CloudTaskSourceService.ts";

function fixture(
  options: {
    dirty?: boolean;
    unpublished?: boolean;
    ancestry?: number;
    exactHead?: boolean;
    trackingSame?: boolean;
    localBranch?: string | null;
    noTracking?: boolean;
    noPushRemote?: boolean;
    pushDefault?: string | null;
    primary?: string | null;
    authFailure?: boolean;
    truncated?: boolean;
    noHead?: boolean;
    localUpstream?: boolean;
  } = {},
) {
  const reads: ReadonlyArray<string>[] = [];
  const sha = "b".repeat(40);
  const layer = CloudSource.layer.pipe(
    Layer.provide(
      Layer.mock(GitVcs.GitVcsDriver)({
        statusDetailsLocal: () =>
          Effect.succeed({
            isRepo: true,
            branch: options.localBranch === undefined ? "feature" : options.localBranch,
            hasWorkingTreeChanges: options.dirty ?? false,
          } as GitVcs.GitStatusDetails),
        execute: (input) => {
          reads.push(input.args);
          const command = input.args.join(" ");
          let stdout = "";
          let exitCode = 0;
          switch (command) {
            case "remote":
              stdout = "fork\nupstream\norigin";
              break;
            case "config --get branch.feature.remote":
              stdout = options.localUpstream ? "." : options.trackingSame ? "fork" : "upstream";
              exitCode = options.noTracking ? 1 : 0;
              break;
            case "config --get branch.feature.pushRemote":
              stdout = "fork";
              exitCode = options.noPushRemote ? 1 : 0;
              break;
            case "config --get remote.pushDefault":
              stdout = options.pushDefault ?? "";
              exitCode = options.pushDefault ? 0 : 1;
              break;
            case "config --get branch.dev.remote":
              exitCode = 1;
              break;
            case "remote get-url --push origin":
              stdout = "git@github.com:acme/repo.git";
              break;
            case "remote get-url --push fork":
              stdout = "git@github.com:acme-fork/repo.git";
              break;
            case "ls-remote --exit-code --heads git@github.com:acme-fork/repo.git refs/heads/feature":
              stdout = `${sha}\trefs/heads/feature\n`;
              exitCode = options.authFailure ? 128 : options.unpublished ? 2 : 0;
              break;
            case "ls-remote --exit-code --heads git@github.com:acme/repo.git refs/heads/dev":
              stdout = `${sha}\trefs/heads/dev\n`;
              break;
            case "ls-remote --exit-code --heads git@github.com:acme/repo.git refs/heads/feature":
              stdout = `${sha}\trefs/heads/feature\n`;
              break;
            case "check-ref-format refs/heads/feature":
              break;
            case "check-ref-format refs/heads/origin/feature":
              break;
            case "check-ref-format refs/heads/dev":
              break;
            case "check-ref-format refs/heads/feature..bad":
              exitCode = 1;
              break;
            case "rev-parse HEAD":
              stdout = options.exactHead ? sha : "a".repeat(40);
              break;
            case "rev-parse --verify HEAD":
              stdout = options.exactHead ? sha : "a".repeat(40);
              exitCode = options.noHead ? 128 : 0;
              break;
            case "rev-parse --verify @{upstream}":
              stdout = sha;
              exitCode = options.noTracking || options.unpublished ? 128 : 0;
              break;
            case "merge-base --is-ancestor HEAD @{upstream}":
              exitCode = options.exactHead ? 0 : (options.ancestry ?? 1);
              break;
            case `merge-base --is-ancestor HEAD ${sha}`:
              exitCode = options.ancestry ?? 1;
              break;
            default:
              if (input.args[0] === "config" && input.args[2]?.endsWith(".remote"))
                stdout = "upstream";
              else if (input.args[0] === "config" && input.args[2]?.endsWith(".pushRemote"))
                stdout = "fork";
              else throw new Error(`Unexpected Git call: ${command}`);
          }
          return Effect.succeed({
            exitCode,
            stdout,
            stderr: "",
            stdoutTruncated: options.truncated === true && input.args[0] === "ls-remote",
            stderrTruncated: false,
          } as GitVcs.ExecuteGitResult);
        },
        resolvePrimaryRemoteName: () => Effect.succeed(options.primary ?? ""),
      }),
    ),
  );
  return { layer, reads, sha };
}

it.effect("uses the pushed fork branch and excludes dirty/ahead local state", () => {
  const f = fixture({ dirty: true });
  return Effect.gen(function* () {
    const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({ cwd: "/repo" });
    assert.deepEqual(result, {
      source: { repository: "https://github.com/acme-fork/repo", branch: "feature", sha: f.sha },
      launchSource: { cwd: "/repo", restriction: "published-ref" },
      localChangesExcluded: true,
    });
    assert.isFalse(
      f.reads.some((args) =>
        ["fetch", "push", "checkout", "worktree", "stash", "commit"].includes(args[0]!),
      ),
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  { options: { dirty: true, exactHead: true }, included: true },
  { options: { exactHead: true }, included: false },
  { options: { ancestry: 0 }, included: false },
  { options: { ancestry: 1 }, included: true },
  { options: { exactHead: true, noTracking: true }, included: true },
  { options: { exactHead: true, unpublished: true }, included: true },
  { options: { noHead: true, noTracking: true }, included: true },
  { options: { exactHead: true, localUpstream: true }, included: true },
])(
  "launches the project folder without requiring a pushed branch (%s)",
  ({ options, included }) => {
    const f = fixture(options);
    return Effect.gen(function* () {
      const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({
        cwd: "/repo/project",
        branch: "feature",
        restriction: "project-folder",
      });
      assert.deepEqual(result, {
        source: {
          repository: "https://github.com/acme-fork/repo",
          branch: "feature",
          ...(options.noHead ? {} : { sha: options.exactHead ? f.sha : "a".repeat(40) }),
        },
        launchSource: { cwd: "/repo/project", restriction: "project-folder" },
        localChangesExcluded: false,
        localChangesIncluded: included,
      });
      assert.isFalse(
        f.reads.some((args) =>
          ["ls-remote", "fetch", "push", "checkout", "worktree", "stash", "commit"].includes(
            args[0]!,
          ),
        ),
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["origin/dev", "refs/remotes/origin/dev"])(
  "resolves explicit remote branch %s without replacing it with tracking metadata",
  (branch) => {
    const f = fixture();
    return Effect.gen(function* () {
      const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({
        cwd: "/repo",
        branch,
      });
      assert.deepEqual(result.source, {
        repository: "https://github.com/acme/repo",
        branch: "dev",
        sha: f.sha,
      });
      assert.isFalse(f.reads.some((args) => args.join(" ").includes("branch.dev.merge")));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["refs/tags/v1", "a".repeat(40), "refs/remotes/missing/dev", "feature..bad"])(
  "refuses non-branch input %s",
  (branch) => {
    const f = fixture();
    return Effect.gen(function* () {
      const error = yield* (yield* CloudSource.CloudTaskSourceService)
        .resolve({ cwd: "/repo", branch })
        .pipe(Effect.flip);
      assert.equal(error.reason, "branch");
      assert.isFalse(f.reads.some((args) => args[0] === "ls-remote"));
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([{ authFailure: true }, { truncated: true }])(
  "surfaces unreadable remote source %s",
  (options) => {
    const f = fixture(options);
    return Effect.gen(function* () {
      const error = yield* (yield* CloudSource.CloudTaskSourceService)
        .resolve({ cwd: "/repo" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "read");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([
  { noTracking: true, noPushRemote: true, pushDefault: "origin", primary: null },
  { noTracking: true, noPushRemote: true, pushDefault: null, primary: "origin" },
])("uses push-default or primary remote without an upstream %s", (options) => {
  const f = fixture(options);
  return Effect.gen(function* () {
    const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({ cwd: "/repo" });
    assert.equal(result.source.repository, "https://github.com/acme/repo");
  }).pipe(Effect.provide(f.layer));
});

it.effect("keeps a local branch named after a remote for project-folder source", () => {
  const f = fixture({ localBranch: "origin/feature", exactHead: true });
  return Effect.gen(function* () {
    const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({
      cwd: "/repo",
      restriction: "project-folder",
    });
    assert.equal(result.source.branch, "origin/feature");
    assert.equal(result.source.repository, "https://github.com/acme-fork/repo");
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses detached and mismatched restricted checkouts without mutation", () => {
  const f = fixture({ localBranch: null, exactHead: true });
  return Effect.gen(function* () {
    const source = yield* CloudSource.CloudTaskSourceService;
    assert.equal((yield* source.resolve({ cwd: "/repo" }).pipe(Effect.flip)).reason, "branch");
    assert.equal(
      (yield* source
        .resolve({ cwd: "/repo", branch: "feature", restriction: "clean-pushed-sha" })
        .pipe(Effect.flip)).reason,
      "source_restriction",
    );
  }).pipe(Effect.provide(f.layer));
});
it.effect(
  "accepts a clean checkout behind the published branch without an exclusion warning",
  () => {
    const f = fixture({ ancestry: 0 });
    return Effect.gen(function* () {
      const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({ cwd: "/repo" });
      assert.isFalse(result.localChangesExcluded);
      assert.equal(result.source.sha, f.sha);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("rejects an unpublished branch before any cloud submission", () => {
  const f = fixture({ unpublished: true });
  return Effect.gen(function* () {
    const error = yield* (yield* CloudSource.CloudTaskSourceService)
      .resolve({ cwd: "/repo" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "unpublished");
    assert.equal(
      error.message,
      "Branch feature is not on fork (https://github.com/acme-fork/repo). Push it, or pass a branch that exists there.",
    );
    assert.isFalse(f.reads.some((args) => args[0] === "rev-parse"));
  }).pipe(Effect.provide(f.layer));
});

it.effect("names both branches when a project-folder launch asks for another branch", () => {
  const f = fixture({ exactHead: true });
  return Effect.gen(function* () {
    const source = yield* CloudSource.CloudTaskSourceService;
    const error = yield* source
      .resolve({ cwd: "/repo", branch: "dev", restriction: "project-folder" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "checkout_mismatch");
    assert.equal(
      error.message,
      "This provider starts from the project folder, which has feature checked out, not dev. Check out dev there, or omit the branch to start from feature.",
    );
    assert.deepEqual(f.reads, []);
    const same = yield* source.resolve({
      cwd: "/repo",
      branch: "refs/heads/feature",
      restriction: "project-folder",
    });
    assert.equal(same.source.branch, "feature");
  }).pipe(Effect.provide(f.layer));
});

it.effect("uses the explicitly selected feature rather than its upstream merge target", () => {
  const f = fixture({ trackingSame: true });
  return Effect.gen(function* () {
    const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({
      cwd: "/repo",
      branch: "feature",
    });
    assert.equal(result.source.branch, "feature");
    assert.isFalse(f.reads.some((args) => args.join(" ").includes("branch.feature.merge")));
  }).pipe(Effect.provide(f.layer));
});
it.effect.each([{ dirty: true, exactHead: true }, { exactHead: false }])(
  "refuses non-clean or non-pushed checkout %s",
  (options) => {
    const f = fixture(options);
    return Effect.gen(function* () {
      const error = yield* (yield* CloudSource.CloudTaskSourceService)
        .resolve({
          cwd: "/repo",
          restriction: "clean-pushed-sha",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "source_restriction");
      assert.isFalse(
        f.reads.some((args) =>
          ["clone", "fetch", "checkout", "worktree", "stash"].includes(args[0]!),
        ),
      );
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("returns the verified existing checkout at the pushed SHA for initial launch", () => {
  const f = fixture({ exactHead: true });
  return Effect.gen(function* () {
    const result = yield* (yield* CloudSource.CloudTaskSourceService).resolve({
      cwd: "/repo",
      restriction: "clean-pushed-sha",
    });
    assert.deepEqual(result.launchSource, { cwd: "/repo", restriction: "clean-pushed-sha" });
    assert.equal(result.source.sha, f.sha);
    assert.isFalse(result.localChangesExcluded);
  }).pipe(Effect.provide(f.layer));
});
