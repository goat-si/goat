import type { ConnectionOnboarding } from "@goat/client-runtime/connection";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { act } from "react";

/** Keep React's act scope open while the test's existing Effect fiber delivers a report. */
export function actEffect<A>(effect: Effect.Effect<A>) {
  return Effect.gen(function* () {
    let release!: () => void;
    const flushing = act(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const outcome = yield* Effect.exit(effect);
    release();
    yield* Effect.promise(() => Promise.resolve(flushing));
    return yield* outcome;
  });
}

export function makeSshProvisionGate() {
  const entered = Deferred.makeUnsafe<ConnectionOnboarding.SshConnectionInput>();
  const release = Deferred.makeUnsafe<unknown>();
  let resolve!: (outcome: unknown) => void;
  const command = (input: ConnectionOnboarding.SshConnectionInput) =>
    new Promise<unknown>((complete) => {
      resolve = complete;
      Deferred.doneUnsafe(entered, Effect.succeed(input));
    });
  const worker = Effect.gen(function* () {
    yield* Deferred.await(entered);
    const outcome = yield* Deferred.await(release);
    resolve(outcome);
  });
  return { entered, release, command, worker };
}
