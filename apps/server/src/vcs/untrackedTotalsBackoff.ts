// @effect-diagnostics nodeBuiltinImport:off - streaming hashes bound memory for arbitrarily many paths.
import * as NodeCrypto from "node:crypto";
import { GitCommandError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

type UntrackedResult =
  | { readonly env: NodeJS.ProcessEnv | undefined }
  | { readonly unavailable: string };

export const failedUntrackedListing = (error: GitCommandError) =>
  Effect.succeed({ unavailable: `Could not list untracked files: ${error.detail}` });

export function makeUntrackedTotalsBackoff(capacity: number) {
  const failures = new Map<
    string,
    { roots: string; count: number; retryAt: number; detail: string }
  >();
  return Effect.fn("GitVcsDriver.untrackedTotalsBackoff")(function* (
    cwd: string,
    roots: ReadonlyArray<string>,
    read: Effect.Effect<UntrackedResult, GitCommandError, Scope.Scope>,
  ) {
    const hash = NodeCrypto.createHash("sha256");
    for (const root of roots) hash.update(root).update("\0");
    const rootsKey = hash.digest("hex");
    const previous = failures.get(cwd);
    const fail = (detail: string) =>
      new GitCommandError({
        operation: "GitVcsDriver.readBranchChangeTotals",
        command: "git ls-files",
        cwd,
        detail,
      });
    if (previous?.roots === rootsKey && (yield* Clock.currentTimeMillis) < previous.retryAt) {
      return yield* fail(previous.detail);
    }
    const result = yield* read;
    if ("unavailable" in result) {
      const count = previous?.roots === rootsKey ? Math.min(previous.count + 1, 6) : 1;
      failures.delete(cwd);
      failures.set(cwd, {
        roots: rootsKey,
        count,
        retryAt:
          (yield* Clock.currentTimeMillis) + Math.min(60_000 * 2 ** (count - 1), 30 * 60_000),
        detail: result.unavailable,
      });
      if (failures.size > capacity) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      return yield* fail(result.unavailable);
    }
    failures.delete(cwd);
    return result;
  });
}
