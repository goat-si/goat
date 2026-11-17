import * as Effect from "effect/Effect";

import { resolveTurnStart } from "./checkpointTurnStart.ts";
import * as VcsDriver from "./VcsDriver.ts";

/** Paths a turn wrote between two checkpoints, leaving out what moving HEAD brought in. */
export const makeListAuthoredPaths = (
  execute: VcsDriver.VcsDriver["Service"]["execute"],
): VcsDriver.VcsCheckpointOps["listAuthoredPaths"] =>
  Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
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

    const listPaths = (args: ReadonlyArray<string>) =>
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
        maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      }).pipe(Effect.map((result) => result.stdout.split("\0")));
    // Remerge diffs retain merge conflict fixes while excluding clean upstream changes.
    const pathLists = yield* Effect.all(
      [
        listPaths(["diff", startHead, `${turnStart}^{commit}`]),
        listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
        listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
        listPaths([
          "log",
          "--format=",
          "--diff-merges=remerge",
          `--since=@${capturedAt}`,
          `${startHead}..${endHead}`,
        ]),
      ],
      { concurrency: "unbounded" },
    );
    return new Set(pathLists.flat().filter((path) => path.length > 0));
  });
