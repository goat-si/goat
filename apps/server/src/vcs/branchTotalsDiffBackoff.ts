import { GitCommandError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

export function makeBranchTotalsDiffBackoff(capacity: number) {
  const failures = new Map<
    string,
    { key: string; count: number; retryAt: number; detail: string }
  >();
  return Effect.fn("GitVcsDriver.branchTotalsDiffBackoff")(function* <A, R>(
    cwd: string,
    key: string | null,
    read: Effect.Effect<A, GitCommandError, R>,
  ) {
    const previous = failures.get(cwd);
    if (
      key !== null &&
      previous?.key === key &&
      (yield* Clock.currentTimeMillis) < previous.retryAt
    ) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.readBranchChangeTotals",
        command: "git diff --numstat",
        cwd,
        detail: previous.detail,
      });
    }
    const result = yield* read.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if (key === null) return;
          const count = previous?.key === key ? Math.min(previous.count + 1, 6) : 1;
          failures.delete(cwd);
          failures.set(cwd, {
            key,
            count,
            retryAt:
              (yield* Clock.currentTimeMillis) +
              Math.min(RETRY_MIN_MS * 2 ** (count - 1), RETRY_MAX_MS),
            detail: error.detail,
          });
          if (failures.size > capacity) {
            const oldest = failures.keys().next().value;
            if (oldest !== undefined) failures.delete(oldest);
          }
        }),
      ),
    );
    failures.delete(cwd);
    return result;
  });
}
