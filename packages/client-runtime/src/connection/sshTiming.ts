import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

type SshConnectionStep =
  | "ensure"
  | "descriptor"
  | "session"
  | "pairing"
  | "authorization"
  | "websocket-open"
  | "initial-snapshot"
  | "ready"
  | "attempt";

export const logSshConnectionTiming = (step: SshConnectionStep, startedAt: bigint, ok = true) =>
  Effect.gen(function* () {
    const wallMs = Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000;
    yield* Effect.logInfo("ssh.postConnect.cost").pipe(
      Effect.annotateLogs({ step, wallMs, outcome: ok ? "ok" : "failed" }),
    );
  });

/** Only fixed step names and durations: results, URLs and error causes can contain credentials. */
export const withSshConnectionTiming =
  (step: SshConnectionStep) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.monotonicTimeNanos;
      return yield* effect.pipe(
        Effect.onExit((exit) => logSshConnectionTiming(step, startedAt, Exit.isSuccess(exit))),
      );
    });
