import type { ServerSettings } from "@goat/contracts";
import { ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

// Publication holds only its host gate. A settings writer never waits for that gate
// while holding the global write semaphore, so staged payload I/O cannot stall settings.
export const makeCheckpointReplicationAdmission = () => {
  const gates = new Map<string, { gate: Semaphore.Semaphore; revision: number }>();
  const forHost = (host: string) => {
    let entry = gates.get(host);
    if (entry === undefined) {
      entry = { gate: Semaphore.makeUnsafe(1), revision: 0 };
      gates.set(host, entry);
    }
    return entry;
  };
  const permit = Effect.fn("ServerSettings.checkpointReplicationPermit")(function* (
    host: string,
    read: Effect.Effect<ServerSettings, ServerSettingsError>,
  ) {
    const entry = forHost(host);
    return yield* entry.gate.withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* read;
        const revision = entry.revision;
        return {
          choice: settings.fleet.hosts?.[host]?.checkpointReplication,
          publish: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            entry.gate.withPermits(1)(
              Effect.suspend(() =>
                entry.revision === revision
                  ? effect.pipe(Effect.asSome)
                  : Effect.succeed(Option.none<A>()),
              ),
            ),
        };
      }),
    );
  });
  const tryCommit = <A, E, R>(
    current: ServerSettings,
    next: ServerSettings,
    commit: Effect.Effect<A, E, R>,
  ) => {
    const changed = [
      ...new Set([
        ...Object.keys(current.fleet.hosts ?? {}),
        ...Object.keys(next.fleet.hosts ?? {}),
      ]),
    ]
      .filter(
        (host) =>
          current.fleet.hosts?.[host]?.checkpointReplication !==
          next.fleet.hosts?.[host]?.checkpointReplication,
      )
      .sort()
      .map(forHost);
    let guarded = commit.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const entry of changed) entry.revision++;
        }),
      ),
      Effect.asSome,
      Effect.uninterruptible,
    );
    for (const entry of changed.toReversed())
      guarded = entry.gate.withPermitsIfAvailable(1)(guarded).pipe(Effect.map(Option.flatten));
    return guarded.pipe(
      Effect.map((result) =>
        Option.isSome(result)
          ? { done: true as const, value: result.value }
          : {
              done: false as const,
              wait: Effect.forEach(changed, ({ gate }) => gate.withPermits(1)(Effect.void), {
                discard: true,
              }),
            },
      ),
    );
  };
  const retry = Effect.fn("ServerSettings.retryCheckpointPublication")(function* <A, E, R>(
    attempt: Effect.Effect<
      { done: true; value: A } | { done: false; wait: Effect.Effect<void> },
      E,
      R
    >,
  ) {
    for (let attemptNumber = 0; attemptNumber < 16; attemptNumber++) {
      const result = yield* attempt;
      if (result.done) return result.value;
      yield* result.wait;
    }
    return yield* new ServerSettingsError({
      settingsPath: "checkpointReplication",
      operation: "normalize",
      cause: "Checkpoint publication remained busy; retry this settings change.",
    });
  });
  return { permit, tryCommit, retry };
};
