// @effect-diagnostics nodeBuiltinImport:off -- This scoped helper owns an OS temporary checkout.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import type { OrchestrationV2CloudTask } from "@goat/contracts";
import { ClaudeCloudError } from "@goat/provider-claude-cloud/server";
import * as ProcessRunner from "../../processRunner.ts";

const isCloudError = Schema.is(ClaudeCloudError);

export const prepare = Effect.fn("ClaudeCloudSourceCheckout.prepare")(function* (input: {
  readonly source: OrchestrationV2CloudTask["source"];
  readonly projectCwd: string;
}): Effect.fn.Return<string, ClaudeCloudError, ProcessRunner.ProcessRunner | Scope.Scope> {
  const source = input.source;
  const fail = (detail: string) => new ClaudeCloudError({ detail, outcome: "rejected" });
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      source.repository,
    ) ||
    !/^[a-f0-9]{40}$/i.test(source.sha ?? "") ||
    !source.branch ||
    source.branch.startsWith("-")
  )
    return yield* fail(
      "Claude Cloud needs a canonical GitHub repository, published branch and exact remote SHA.",
    );
  const environment = yield* HostProcess.Environment;
  if (Object.entries(environment).some(([key, value]) => key.startsWith("GIT_") && value))
    return yield* fail(
      "Inherited Git routing/configuration prevents an isolated source checkout. Remove it before starting Claude Cloud.",
    );
  const runner = yield* ProcessRunner.ProcessRunner;
  const cwd = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-claude-cloud-")),
      catch: (cause) =>
        new ClaudeCloudError({
          detail: "Could not create a disposable Claude Cloud checkout outside the project.",
          outcome: "rejected",
          cause,
        }),
    }),
    (directory) =>
      Effect.tryPromise({
        try: () => NodeFSP.rm(directory, { recursive: true, force: true }),
        catch: (cause) =>
          new ClaudeCloudError({
            detail: "Could not remove the disposable Claude Cloud checkout after sender exit.",
            outcome: "rejected",
            cause,
          }),
      }).pipe(Effect.catch((error) => Effect.logWarning(error.detail))),
  );
  const rel = NodePath.relative(input.projectCwd, cwd);
  if (!rel || (!rel.startsWith("..") && !NodePath.isAbsolute(rel)))
    return yield* fail("The disposable checkout must be outside the project.");
  const git = (args: string[]) =>
    runner
      .run({
        command: "git",
        args: [`--git-dir=${NodePath.join(cwd, ".git")}`, `--work-tree=${cwd}`, ...args],
        cwd,
        timeout: "30 seconds",
        maxOutputBytes: 65536,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0 && !result.timedOut && !result.stdoutTruncated
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(fail("Could not prepare the exact pushed remote SHA for Claude Cloud.")),
        ),
        Effect.mapError((cause) =>
          isCloudError(cause)
            ? cause
            : new ClaudeCloudError({
                detail: "Could not prepare the exact pushed remote SHA for Claude Cloud.",
                outcome: "rejected",
                cause,
              }),
        ),
      );
  yield* git(["check-ref-format", `refs/heads/${source.branch}`]);
  yield* git(["init", "--quiet", "--template="]);
  yield* git(["remote", "add", "origin", source.repository]);
  yield* git(["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${source.branch}`]);
  const fetched = yield* git(["rev-parse", "FETCH_HEAD"]);
  if (fetched.toLowerCase() !== source.sha!.toLowerCase())
    return yield* fail(
      "The published branch moved after preflight. Retry with a freshly resolved source; no cloud task was started.",
    );
  yield* git([
    "-c",
    `core.hooksPath=${NodePath.join(cwd, "no-hooks")}`,
    "checkout",
    "--quiet",
    "-b",
    source.branch,
    source.sha!,
  ]);
  const head = yield* git(["rev-parse", "HEAD"]);
  const dirty = yield* git([
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (head.toLowerCase() !== source.sha!.toLowerCase() || dirty)
    return yield* fail("The disposable Claude Cloud checkout is not clean at the pushed SHA.");
  return cwd;
});
