import * as Effect from "effect/Effect";

import { resolveTurnStart } from "./checkpointTurnStart.ts";
import * as VcsDriver from "./VcsDriver.ts";

// Reflog subjects that only point a ref at an existing commit. Anything else counts as creating
// one, so an unknown subject keeps its commit attributed.
const REF_MOVE_REFLOG_SUBJECT =
  /^(?:$|(?:checkout|reset|branch|clone|fetch)\b|[^:]*\((?:start|finish|abort|reset)\): |(?:merge|pull|rebase|cherry-pick)\b[^()]*: fast-forward$)/i;

/** Paths a turn wrote between two checkpoints, leaving out what moving HEAD brought in. */
export const makeListAuthoredPaths = (
  execute: VcsDriver.VcsDriver["Service"]["execute"],
): VcsDriver.VcsCheckpointOps["listAuthoredPaths"] => {
  let remergeDiffSupported: boolean | undefined;
  const supportsRemergeDiff = Effect.fn("GitVcsDriver.supportsRemergeDiff")(function* (
    cwd: string,
  ) {
    if (remergeDiffSupported === undefined) {
      const version = yield* execute({
        operation: "GitVcsDriver.version",
        cwd,
        args: ["version"],
      }).pipe(Effect.option);
      if (version._tag === "None") return false;
      const match = /^git version (\d+)\.(\d+)/.exec(version.value.stdout);
      remergeDiffSupported =
        match !== null &&
        (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 36));
    }
    return remergeDiffSupported;
  });
  return Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
    const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
    const turnStart = yield* resolveTurnStart(execute, input);
    const heads = yield* execute({
      operation,
      cwd: input.cwd,
      args: [
        "log",
        "--no-walk=unsorted",
        "--format=%ct %P",
        `${turnStart}^{commit}`,
        `${input.toCheckpointRef}^{commit}`,
      ],
    });
    const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
    const [capturedAt = "", startHead = ""] = fromLine.split(" ");
    const [, endHead = ""] = toLine.split(" ");
    if (startHead === "" || endHead === "" || startHead === endHead) {
      return null;
    }

    const listLines = (args: ReadonlyArray<string>, stdin?: string) =>
      execute({
        operation,
        cwd: input.cwd,
        // log.showSignature prints verification text into the output.
        args: ["-c", "log.showSignature=false", ...args],
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      }).pipe(Effect.map((result) => result.stdout.split("\n").filter((line) => line !== "")));
    const listPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      execute({
        operation,
        cwd: input.cwd,
        args: [
          "-c",
          "diff.relative=false",
          // log.showSignature prints verification text into the path list.
          "-c",
          "log.showSignature=false",
          ...args,
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
        ],
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      }).pipe(Effect.map((result) => result.stdout.split("\0")));

    // A commit is an import when a fetch delivered it since the previous checkpoint and no reflog
    // in any worktree shows this repository creating it. --all covers every worktree's HEAD, and
    // with --walk-reflogs --since compares each entry's own time.
    const listImportedCommits = Effect.gen(function* () {
      const entries = (yield* listLines([
        "log",
        "--walk-reflogs",
        "--all",
        `--since=@${capturedAt}`,
        "--format=%H %gD %gs",
      ])).map((line) => {
        const [commit = "", selector = "", ...subject] = line.split(" ");
        return {
          commit,
          fetched: selector.startsWith("refs/remotes/"),
          subject: subject.join(" "),
        };
      });
      // A push records commits this repository already had.
      const fetchedTips = new Set(
        entries
          .filter((entry) => entry.fetched && entry.subject !== "update by push")
          .map((entry) => entry.commit),
      );
      if (fetchedTips.size === 0) return fetchedTips;
      // Fetching another branch can deliver a commit that was made here and pushed.
      const createdHere = new Set(
        entries
          .filter((entry) => !entry.fetched && !REF_MOVE_REFLOG_SUBJECT.test(entry.subject))
          .map((entry) => entry.commit),
      );
      const fetched = yield* listLines(
        ["rev-list", `--since=@${capturedAt}`, "--stdin"],
        `${[...fetchedTips, `^${startHead}`].join("\n")}\n`,
      );
      return new Set(fetched.filter((commit) => !createdHere.has(commit)));
    });

    // Remerge diffs retain merge conflict fixes while excluding clean upstream changes.
    // Older Git gets dense combined diffs, which miss a conflict resolved to one side's
    // version, so it also keeps every path more than one parent changed since the merge base.
    const remerge = yield* supportsRemergeDiff(input.cwd);
    const listMergeSharedPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      listLines(["rev-list", "--merges", "--parents", ...args], stdin).pipe(
        Effect.flatMap((merges) =>
          Effect.forEach(
            merges,
            Effect.fnUntraced(function* (merge) {
              const parents = merge.split(" ").slice(1);
              const [base] = yield* listLines(["merge-base", "--octopus", ...parents]).pipe(
                // Unrelated histories have no merge base; the combined diff still applies.
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
              );
              if (base === undefined) return [];
              const changed = yield* Effect.forEach(
                parents,
                (parent) => listPaths(["diff", base, parent]),
                { concurrency: "unbounded" },
              );
              const counts = new Map<string, number>();
              for (const path of changed.flatMap((paths) => [...new Set(paths)])) {
                if (path === "") continue;
                counts.set(path, (counts.get(path) ?? 0) + 1);
              }
              return [...counts].flatMap(([path, count]) => (count > 1 ? [path] : []));
            }),
            { concurrency: 4 },
          ),
        ),
        Effect.map((lists) => lists.flat()),
      );
    const listCommitPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      remerge
        ? listPaths(["log", ...args, "--format=", "--diff-merges=remerge"], stdin)
        : Effect.all(
            [
              listPaths(["log", ...args, "--format=", "--cc"], stdin),
              listMergeSharedPaths(args, stdin),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map((lists) => lists.flat()));
    const [recentCommits, ...pathLists] = yield* Effect.all(
      [
        listLines(["rev-list", `--since=@${capturedAt}`, `${startHead}..${endHead}`]),
        listPaths(["diff", startHead, `${turnStart}^{commit}`]),
        listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
        listCommitPaths([`${endHead}..${startHead}`]),
      ],
      { concurrency: "unbounded" },
    );
    // Without readable reflogs every recent commit stays attributed, as before.
    const importedCommits =
      recentCommits.length === 0
        ? new Set<string>()
        : yield* listImportedCommits.pipe(Effect.orElseSucceed(() => new Set<string>()));
    const ownCommits = recentCommits.filter((commit) => !importedCommits.has(commit));
    const ownCommitPaths =
      ownCommits.length === 0
        ? []
        : yield* listCommitPaths(["--no-walk=unsorted", "--stdin"], `${ownCommits.join("\n")}\n`);
    return new Set([...pathLists.flat(), ...ownCommitPaths].filter((path) => path.length > 0));
  });
};
