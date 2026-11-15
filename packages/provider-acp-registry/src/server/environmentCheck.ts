import * as Effect from "effect/Effect";

/** An environment as one comparable string. */
export const environmentText = (environment: NodeJS.ProcessEnv) =>
  JSON.stringify(Object.entries(environment).toSorted(([a], [b]) => a.localeCompare(b)));

/**
 * Runs `attempt` again while the environment it captured is no longer current when it finishes,
 * three runs at most; the last result stands. The caller's commit follows without I/O, though
 * Effect's scheduler may still switch fibers between the comparison and that commit.
 */
export const untilEnvironmentHolds = Effect.fn("AcpRegistryDriver.untilEnvironmentHolds")(
  function* <A, E, R>(
    current: Effect.Effect<NodeJS.ProcessEnv>,
    attempt: Effect.Effect<{ readonly environment: NodeJS.ProcessEnv; readonly result: A }, E, R>,
  ) {
    for (let runs = 1; ; runs++) {
      const { environment, result } = yield* attempt;
      if (runs === 3 || environmentText(yield* current) === environmentText(environment)) {
        return result;
      }
    }
  },
);
