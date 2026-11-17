// @effect-diagnostics nodeBuiltinImport:off -- isUtf8 checks a NUL-delimited index record before it is sent on stdin.
import * as NodeBuffer from "node:buffer";
import * as Effect from "effect/Effect";

import type * as VcsDriver from "./VcsDriver.ts";
import type * as VcsProcess from "./VcsProcess.ts";

/**
 * Restores the tracked files of a checkpoint commit. git restore leaves skip-worktree paths alone;
 * outside a sparse checkout every such bit was set by hand and capture recorded the file, so all
 * are overridden. In a sparse checkout the exclusions stay excluded and only the skip-worktree
 * paths the sparse rules select are restored again.
 */
export const restoreCheckpointFiles = Effect.fn("GitVcsDriver.checkpoints.restoreCheckpointFiles")(
  function* (input: {
    readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
    readonly vcsProcess: VcsProcess.VcsProcess["Service"];
    readonly operation: string;
    readonly cwd: string;
    readonly commitOid: string;
    readonly longPaths: ReadonlyArray<string>;
  }) {
    const { execute, vcsProcess, operation, cwd, commitOid, longPaths } = input;
    const sparseConfig = yield* execute({
      operation,
      cwd,
      args: ["config", "--bool", "core.sparseCheckout"],
      allowNonZeroExit: true,
    });
    const sparseCheckout = sparseConfig.stdout.trim() === "true";
    const restore = [...longPaths, "restore", "--source", commitOid, "--worktree", "--staged"];
    yield* execute({
      operation,
      cwd,
      args: [...restore, ...(sparseCheckout ? [] : ["--ignore-skip-worktree-bits"]), "--", "."],
    });
    if (!sparseCheckout) return;
    const manual = yield* Effect.gen(function* () {
      const skipped: string[] = [];
      let recordStart = true;
      let keep = false;
      let record: Uint8Array[] = [];
      yield* vcsProcess.run({
        operation,
        command: "git",
        cwd,
        args: ["ls-files", "--full-name", "--sparse", "-v", "-z", "--", "."],
        maxOutputBytes: 4_096,
        outputMode: "truncate",
        // The index can be huge; keep only the "S "/"s " records of the NUL-delimited list.
        onStdoutChunk: (chunk) => {
          let start = 0;
          while (start < chunk.length) {
            const end = chunk.indexOf(0, start);
            if (recordStart) {
              keep = chunk[start] === 83 || chunk[start] === 115;
              record = [];
            }
            if (keep) {
              record.push(Buffer.from(chunk.subarray(start, end === -1 ? undefined : end)));
              if (end !== -1) {
                const entry = Buffer.concat(record).subarray(2);
                record = [];
                // Sparse directory entries are exclusions; stdin cannot carry non-UTF-8.
                if (entry.at(-1) !== 47 && NodeBuffer.isUtf8(entry))
                  skipped.push(entry.toString("utf8"));
              }
            }
            recordStart = end !== -1;
            if (!recordStart) break;
            start = end + 1;
          }
        },
      });
      if (skipped.length === 0) return skipped;
      const stdin = skipped.join("\0") + "\0";
      // check-rules echoes a subset of its input, so the input size bounds its output.
      const rules = yield* execute({
        operation,
        cwd,
        args: ["sparse-checkout", "check-rules", "-z"],
        stdin,
        maxOutputBytes: Buffer.byteLength(stdin),
        outputMode: "error",
      });
      return rules.stdout.split("\0").filter((entry) => entry.length > 0);
    }).pipe(
      // A Git without ls-files --sparse or check-rules keeps the plain restore's result.
      Effect.orElseSucceed((): string[] => []),
    );
    if (manual.length === 0) return;
    yield* execute({
      operation,
      cwd,
      args: [
        ...restore,
        "--ignore-skip-worktree-bits",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      stdin: manual.map((entry) => `:(top,literal)${entry}\0`).join(""),
    });
  },
);
