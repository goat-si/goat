import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import type * as Scope from "effect/Scope";

import { SshCommandError, SshPreparationTimeoutError, SshReadinessError } from "./errors.ts";
import { runtimeFailureResult } from "./sshFailureDiagnostics.ts";

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

/** Set while a retry loop runs its own attempt, so that attempt's failure does not restart it. */
const SshAutomaticRetry = Context.Reference<boolean>(
  "@goat/ssh/preparationRetry/SshAutomaticRetry",
  { defaultValue: () => false },
);

/**
 * A failure a later attempt can outlast: a timeout, a dropped or refused connection (ssh exit
 * 255), or a server too slow to answer. Authentication, host keys, a local proxy and runtime
 * problems need a person, so they never loop.
 */
export function isTransientPreparationFailure(error: unknown) {
  if (error instanceof SshPreparationTimeoutError || error instanceof SshReadinessError)
    return true;
  if (!(error instanceof SshCommandError) || (error.exitCode !== null && error.exitCode !== 255))
    return false;
  const result = runtimeFailureResult("host", "", null, error);
  return result.kind === "error" && result.fix?.actor !== "human";
}

/** Capped exponential backoff with jitter: 1-2 s, then 2-4 s, doubling up to 30-60 s. */
export function preparationRetryDelayMs(attempt: number, random: number) {
  const ceiling = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

interface RetryLoop {
  readonly generation: number | undefined;
  fiber?: Fiber.Fiber<void>;
}

/**
 * Retries a preparation that failed transiently, in the manager scope, until it succeeds, fails
 * for a reason a person must fix, or the host no longer wants this generation's environment.
 */
export function makePreparationRetries<E, R>(options: {
  readonly scope: Scope.Scope;
  /** The host is still configured for this generation and has no forward yet. */
  readonly wanted: (key: string, generation: number | undefined) => boolean;
  readonly attempt: (target: DesktopSshEnvironmentTarget) => Effect.Effect<unknown, E, R>;
}) {
  const loops = new Map<string, RetryLoop>();
  const cancel = (key: string) =>
    Effect.suspend(() => {
      const loop = loops.get(key);
      loops.delete(key);
      return loop?.fiber === undefined ? Effect.void : Fiber.interrupt(loop.fiber);
    });
  const run = Effect.fn("ssh/preparationRetry.run")(
    function* (key: string, loop: RetryLoop, target: DesktopSshEnvironmentTarget) {
      for (let count = 0; ; count++) {
        const delayMs = preparationRetryDelayMs(count, yield* Random.next);
        yield* Effect.logInfo("ssh.preparation.retry.scheduled", {
          key,
          attempt: count + 1,
          delayMs,
        });
        yield* Effect.sleep(delayMs);
        if (!options.wanted(key, loop.generation)) return;
        const exit = yield* Effect.exit(
          options.attempt(target).pipe(Effect.provideService(SshAutomaticRetry, true)),
        );
        if (Exit.isSuccess(exit) || !options.wanted(key, loop.generation)) return;
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isNone(error) || !isTransientPreparationFailure(error.value)) return;
      }
    },
    (effect, key, loop) =>
      Effect.ensuring(
        effect,
        Effect.sync(() => {
          if (loops.get(key) === loop) loops.delete(key);
        }),
      ),
  );
  /**
   * After a caller's attempt failed: a transient failure (re)starts the loop from the shortest
   * delay, so a manual Retry resets the backoff; any other failure stops it.
   */
  const failed = Effect.fn("ssh/preparationRetry.failed")(function* (
    key: string,
    generation: number | undefined,
    error: unknown,
    target: DesktopSshEnvironmentTarget,
  ) {
    if (yield* SshAutomaticRetry) return;
    yield* cancel(key);
    if (!isTransientPreparationFailure(error) || !options.wanted(key, generation)) return;
    const loop: RetryLoop = { generation };
    loops.set(key, loop);
    loop.fiber = yield* Effect.forkIn(run(key, loop, target), options.scope);
  });
  /** Refusal copy for a ready-only caller while the host reconnects on its own. */
  const refusal = (key: string, host: string) =>
    loops.has(key)
      ? `GOAT lost its SSH connection to ${host} and is reconnecting automatically. Try again in a minute.`
      : undefined;
  return { failed, cancel, refusal };
}
