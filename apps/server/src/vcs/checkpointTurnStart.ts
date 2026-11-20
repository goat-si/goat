import type { CheckpointRef } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

type Execute = VcsDriver.VcsDriver["Service"]["execute"];

const HEAD_MOVES_SCAN_LIMIT = 512;
const HEAD_MARK_TRAILER = "T3-Head-Moved-At";
const HEAD_MARK_TRAILER_PATTERN = new RegExp(`^${HEAD_MARK_TRAILER}: (\\d+) (\\d+)$`, "m");

interface HeadMove {
  readonly to: string;
  readonly at: string;
  readonly reason: string;
}

/** Newest first: the commit each HEAD move landed on, when, and Git's reason for it. */
export const readHeadMoves = (
  execute: Execute,
  cwd: string,
): Effect.Effect<ReadonlyArray<HeadMove>> =>
  execute({
    operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
    cwd,
    args: [
      "-c",
      "log.showSignature=false",
      "log",
      "--walk-reflogs",
      "-n",
      String(HEAD_MOVES_SCAN_LIMIT),
      "--date=unix",
      "--format=%H %gd %gs",
      "HEAD",
      "--",
    ],
    allowNonZeroExit: true,
  }).pipe(
    Effect.map((result) =>
      result.exitCode !== 0
        ? []
        : result.stdout.split("\n").flatMap((line) => {
            const [, to, at, reason] = /^([0-9a-f]+) HEAD@\{(\d+)\} (.*)$/.exec(line) ?? [];
            return to === undefined || at === undefined || reason === undefined
              ? []
              : [{ to, at, reason }];
          }),
    ),
    Effect.orElseSucceed(() => []),
  );

/**
 * Where HEAD's reflog stood when this checkpoint pinned head. Moves share a second, so the mark
 * also counts how many of that second it has seen.
 */
export const headMarkFor = (headMoves: ReadonlyArray<HeadMove>, head: string | null) => {
  const lastMove = headMoves.at(0);
  return lastMove !== undefined && lastMove.to === head
    ? `${lastMove.at} ${headMoves.filter((move) => move.at === lastMove.at).length}`
    : undefined;
};

export const headMarkTrailer = (headMark: string | undefined) =>
  headMark === undefined ? "" : `\n\n${HEAD_MARK_TRAILER}: ${headMark}`;

/**
 * Switching branches rewrites files the turn never wrote, and only HEAD's reflog tells a switch
 * from a reset. When the previous checkpoint's mark shows checkout switches since it, this builds
 * the previous checkpoint with those switches applied: where this turn started. Null otherwise.
 */
export const buildTurnStart = (input: {
  readonly execute: Execute;
  readonly operation: string;
  readonly cwd: string;
  readonly checkpointRef: string;
  readonly previousCheckpointRef: CheckpointRef | undefined;
  readonly headMark: string | undefined;
  readonly headMoves: ReadonlyArray<HeadMove>;
  readonly indexConfig: ReadonlyArray<string>;
  readonly durableWrite: ReadonlyArray<string>;
  readonly commitEnv: NodeJS.ProcessEnv;
}): Effect.Effect<string | null> => {
  const { execute, operation, cwd, headMoves, indexConfig, durableWrite, commitEnv } = input;
  if (input.headMark === undefined || input.previousCheckpointRef === undefined)
    return Effect.succeed(null);
  const previousCheckpointRef = input.previousCheckpointRef;
  return Effect.gen(function* () {
    const previous = yield* execute({
      operation,
      cwd,
      args: [
        "-c",
        "log.showSignature=false",
        "log",
        "--no-walk",
        "--format=%H %T %ct %P%n%B",
        `${previousCheckpointRef}^{commit}`,
      ],
      allowNonZeroExit: true,
    });
    if (previous.exitCode !== 0) return null;
    const [commit = "", tree = "", capturedAt = "", previousHead = ""] = previous.stdout
      .slice(0, previous.stdout.indexOf("\n"))
      .split(" ");
    const [, markedAt, markedCount] = HEAD_MARK_TRAILER_PATTERN.exec(previous.stdout) ?? [];
    const oldestMarked = headMoves.findLastIndex((move) => move.at === markedAt);
    // -1 when the scan ended inside the marked second, so the count cannot be placed.
    const since =
      oldestMarked === HEAD_MOVES_SCAN_LIMIT - 1 ? -1 : oldestMarked - Number(markedCount) + 1;
    if (headMoves[since]?.to !== previousHead) return null;
    const switches = headMoves
      .slice(0, since)
      .flatMap((move, index) => {
        const from = headMoves[index + 1]?.to;
        return from === undefined ? [] : [{ ...move, from }];
      })
      .filter((move) => move.reason.startsWith("checkout: moving from ") && move.from !== move.to)
      .toReversed();
    const landedOn = switches.at(-1)?.to;
    if (landedOn === undefined) return null;

    yield* execute({
      operation,
      cwd,
      args: [...indexConfig, "-c", "index.sparse=false", "read-tree", tree],
      env: commitEnv,
    });
    for (const { from, to } of switches) {
      const changes = yield* execute({
        operation,
        cwd,
        args: ["-c", "core.quotePath=true", "diff-tree", "-r", "--no-renames", from, to],
        maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      // A switch succeeds only where the files it replaces were unmodified, so each changed path
      // takes the destination's version. Mode 000000 drops the path.
      const entries = changes.stdout
        .split("\n")
        // A switch leaves a submodule's own checkout where it was.
        .filter((line) => line !== "" && !/^:(?:160000 |[0-7]{6} 160000 )/.test(line))
        .map((line) =>
          line.replace(/^:[0-7]{6} ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\t/, "$1 $2\t"),
        );
      if (entries.length === 0) continue;
      yield* execute({
        operation,
        cwd,
        args: [...indexConfig, "-c", "index.sparse=false", "update-index", "--index-info"],
        stdin: `${entries.join("\n")}\n`,
        env: commitEnv,
      });
    }
    const startTree = (yield* execute({
      operation,
      cwd,
      args: [...indexConfig, ...durableWrite, "write-tree"],
      env: commitEnv,
    })).stdout.trim();
    if (startTree === "" || startTree === tree) return null;
    const startCommit = yield* execute({
      operation,
      cwd,
      args: [
        ...durableWrite,
        "commit-tree",
        startTree,
        "-p",
        landedOn,
        "-p",
        commit,
        "-m",
        `goat checkpoint turn start ref=${input.checkpointRef}`,
      ],
      // listAuthoredPaths reads commits newer than the start as the turn's own.
      env: { ...commitEnv, GIT_COMMITTER_DATE: `${capturedAt} +0000` },
    });
    return startCommit.stdout.trim() || null;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("checkpoint branch switch turn start failed", {
        cwd,
        checkpointRef: input.checkpointRef,
        cause: String(cause),
      }).pipe(Effect.as(null)),
    ),
  );
};

/**
 * A checkpoint taken after a branch switch has a second parent: the checkpoint before it with the
 * switch applied, which is where that turn started. Other ranges start at `from` itself.
 */
export const resolveTurnStart = (
  execute: Execute,
  input: {
    readonly cwd: string;
    readonly fromCheckpointRef: string;
    readonly toCheckpointRef: string;
  },
) =>
  execute({
    operation: "GitVcsDriver.checkpoints.resolveTurnStart",
    cwd: input.cwd,
    args: [
      "-c",
      "log.showSignature=false",
      "log",
      "--no-walk=unsorted",
      "--format=%H %P",
      `${input.fromCheckpointRef}^{commit}`,
      `${input.toCheckpointRef}^2`,
    ],
    allowNonZeroExit: true,
  }).pipe(
    Effect.map((result): string => {
      const [fromLine = "", startLine = ""] = result.stdout.trimEnd().split("\n");
      const [start = "", , startedFrom] = startLine.split(" ");
      return result.exitCode === 0 && startedFrom === fromLine.split(" ")[0]
        ? start
        : input.fromCheckpointRef;
    }),
  );
