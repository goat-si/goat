import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { GitCommandError } from "@goat/contracts";

export interface SharedConfigDriver {
  readonly createBranch: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly startPoint: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly writeConfigValue: (input: {
    readonly cwd: string;
    readonly key: string;
    readonly value: string;
  }) => Effect.Effect<void, GitCommandError>;
}

const locks = new Map<string, Semaphore.Semaphore>();

// Git execution already owns the operation span.
export const runSharedConfigCommand = Effect.fnUntraced(function* <
  A extends { readonly exitCode: number | null; readonly stderr: string },
  E,
>(input: {
  readonly command: Effect.Effect<A, E>;
  readonly repository: Effect.Effect<string | null, E>;
  readonly write: boolean;
  readonly retry: boolean;
}) {
  if (!input.write && !input.retry) return yield* input.command;
  const attempt = Effect.gen(function* () {
    for (let count = 0; ; count++) {
      const result = yield* input.command;
      if (
        !input.retry ||
        result.exitCode === 0 ||
        count === 10 ||
        !/could not lock config file .+: File exists/i.test(result.stderr)
      )
        return result;
      yield* Effect.sleep("50 millis");
    }
  });
  if (!input.write) return yield* attempt;
  const key = yield* input.repository;
  if (key === null) return yield* attempt;
  let lock = locks.get(key);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(key, lock);
  }
  return yield* lock.withPermit(attempt);
});

export const recordPushedUpstream = Effect.fn("GitSharedConfig.recordPushedUpstream")(
  function* <E>(input: {
    branch: string;
    remote: string;
    publishBranch: string;
    write: (key: string, value: string) => Effect.Effect<void, E>;
    read: (key: string) => Effect.Effect<string | null, E>;
  }) {
    yield* input.write(`branch.${input.branch}.merge`, `refs/heads/${input.publishBranch}`);
    yield* input.write(`branch.${input.branch}.remote`, input.remote);
    const rebase = yield* input.read("branch.autoSetupRebase");
    if (rebase === "always" || rebase === "remote")
      yield* input.write(`branch.${input.branch}.rebase`, "true");
    return true;
  },
  Effect.catch((cause) =>
    Effect.logWarning("pushed, but could not record the branch upstream", { cause }).pipe(
      Effect.as(false),
    ),
  ),
);
