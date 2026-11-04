// @effect-diagnostics globalTimers:off -- the Promise-based git child needs a plain kill deadline.
// @effect-diagnostics nodeBuiltinImport:off -- Git index plumbing and NUL-delimited paths require native process and filesystem IO.
import * as NodeChildProcess from "node:child_process";
import { guardChild } from "@goat/shared/errorGuards";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class RestoreSnapshotError extends Schema.TaggedError<RestoreSnapshotError>()(
  "RestoreSnapshotError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const GIT_TIMEOUT_MS = 5 * 60_000;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

export const git = (cwd: string, args: string[], options?: { index?: string; input?: Buffer }) =>
  new Promise<Buffer>((resolvePromise, reject) => {
    const child = guardChild(
      NodeChildProcess.spawn("git", args, {
        cwd,
        env: { ...process.env, ...(options?.index ? { GIT_INDEX_FILE: options.index } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      }),
      reject,
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let stopped: string | null = null;
    const stop = (reason: string) => {
      stopped ??= reason;
      child.kill("SIGKILL");
    };
    // Checkout filters and hooks can print or wait without end; one restore must not hold the server.
    const deadline = setTimeout(() => stop("timed out"), GIT_TIMEOUT_MS);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > GIT_OUTPUT_LIMIT) stop("printed too much output");
      else into.push(chunk);
    };
    child.stdout.on("data", collect(output));
    child.stderr.on("data", collect(errors));
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (stopped !== null) reject(new Error(`git ${args[0]} ${stopped}`));
      else if (code === 0) resolvePromise(Buffer.concat(output));
      else
        reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(errors).toString()}`));
    });
    child.stdin.end(options?.input);
  });

const text = async (cwd: string, ...args: string[]) => (await git(cwd, args)).toString().trim();
const withIndex = async <T>(
  cwd: string,
  copy: boolean,
  fn: (index: string) => Promise<T>,
): Promise<T> => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-restore-"));
  const index = NodePath.join(dir, "index");
  try {
    if (copy) {
      const indexPath = await text(cwd, "rev-parse", "--git-path", "index");
      await NodeFSP.copyFile(NodePath.resolve(cwd, indexPath), index);
    }
    return await fn(index);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
};

export const applySnapshotToWorktree = Effect.fn("restoreSnapshot.applySnapshotToWorktree")(
  (input: { cwd: string; snapshotSha: string }) =>
    Effect.tryPromise({
      try: async () => {
        const cwd = await NodeFSP.realpath(input.cwd);
        const sha = input.snapshotSha;
        const deleted = await git(cwd, [
          "diff",
          "-z",
          "--name-only",
          "--no-renames",
          "--diff-filter=D",
          `${sha}^1`,
          sha,
        ]);
        for (const name of deleted.toString().split("\0").filter(Boolean)) {
          const path = NodePath.resolve(cwd, name);
          const rel = NodePath.relative(cwd, path);
          if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel))
            throw new Error("Invalid snapshot path");
          await NodeFSP.rm(path, { force: true });
          let parent = NodePath.dirname(path);
          while (
            parent !== cwd &&
            NodePath.relative(cwd, parent) &&
            !NodePath.relative(cwd, parent).startsWith("..")
          ) {
            try {
              await NodeFSP.rmdir(parent);
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
                (error as NodeJS.ErrnoException).code === "ENOENT"
              )
                break;
              throw error;
            }
            parent = NodePath.dirname(parent);
          }
        }
        const changed = await git(cwd, [
          "diff",
          "-z",
          "--name-only",
          "--no-renames",
          "--diff-filter=AMT",
          `${sha}^1`,
          sha,
        ]);
        if (changed.length)
          await withIndex(cwd, false, async (index) => {
            await git(cwd, ["read-tree", sha], { index });
            await git(cwd, ["checkout-index", "-f", "-z", "--stdin"], { index, input: changed });
          });
        const staged = await git(cwd, [
          "diff",
          "-z",
          "--name-only",
          "--no-renames",
          `${sha}^1`,
          `${sha}^2`,
        ]);
        if (staged.length)
          await git(
            cwd,
            [
              "restore",
              "--staged",
              `--source=${sha}^2`,
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            { input: staged },
          );
      },
      catch: (cause) => new RestoreSnapshotError({ detail: "apply", cause }),
    }),
);

const isRestoreSnapshotError = Schema.is(RestoreSnapshotError);

export const verifyRestoredWorktree = Effect.fn("restoreSnapshot.verifyRestoredWorktree")(
  (input: {
    cwd: string;
    expectedPath?: string;
    branch: string;
    expectedHead: string;
    snapshot?: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const cwd = await NodeFSP.realpath(input.cwd);
        const expected = await NodeFSP.realpath(input.expectedPath ?? input.cwd);
        const check = (condition: boolean, detail: string) => {
          if (!condition) throw new RestoreSnapshotError({ detail });
        };
        check(cwd === expected, "path");
        check(
          (await NodeFSP.realpath(await text(cwd, "rev-parse", "--show-toplevel"))) === expected,
          "toplevel",
        );
        check((await text(cwd, "symbolic-ref", "HEAD")) === `refs/heads/${input.branch}`, "branch");
        check((await text(cwd, "rev-parse", "HEAD")) === input.expectedHead, "head");
        if (input.snapshot) {
          const snapshot = input.snapshot;
          const actual = await withIndex(cwd, true, async (index) => {
            await git(cwd, ["add", "-A"], { index });
            return (await git(cwd, ["write-tree"], { index })).toString().trim();
          });
          check(actual === (await text(cwd, "rev-parse", `${snapshot}^{tree}`)), "worktree-tree");
          check(
            (await text(cwd, "write-tree")) ===
              (await text(cwd, "rev-parse", `${snapshot}^2^{tree}`)),
            "index-tree",
          );
        }
      },
      catch: (cause) =>
        isRestoreSnapshotError(cause)
          ? cause
          : new RestoreSnapshotError({ detail: "verification", cause }),
    }),
);

export const pathExists = async (path: string) => {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
