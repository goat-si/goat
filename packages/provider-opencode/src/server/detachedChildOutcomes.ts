import * as Effect from "effect/Effect";
import type { OpenCodeThreadState, TerminalTurnStatus } from "./adapterState.ts";

const MAX_UNCORRELATED_OUTCOMES = 1024;

export function makeDetachedChildOutcomes(
  parentOf: (sessionId: string) => OpenCodeThreadState | undefined,
) {
  const outcomes = new Map<string, TerminalTurnStatus>();
  const stops = new Map<string, number>();
  const isStopping = (sessionId: string) => {
    for (let parent = parentOf(sessionId); parent; parent = parent.parentSubagent?.parentState) {
      if (stops.has(parent.nativeSessionId)) return true;
    }
    return false;
  };

  return {
    isStopping,
    observe(sessionId: string, status: TerminalTurnStatus, finalized: boolean) {
      const outcome = finalized
        ? status
        : (outcomes.get(sessionId) ?? (isStopping(sessionId) ? "interrupted" : status));
      if (!outcomes.has(sessionId) && outcomes.size >= MAX_UNCORRELATED_OUTCOMES) {
        const oldest = outcomes.keys().next();
        if (!oldest.done) outcomes.delete(oldest.value);
      }
      outcomes.set(sessionId, outcome);
      return outcome;
    },
    take(sessionId: string): TerminalTurnStatus | undefined {
      const outcome = outcomes.get(sessionId);
      outcomes.delete(sessionId);
      return outcome ?? (isStopping(sessionId) ? "interrupted" : undefined);
    },
    withStop<A, E, R>(sessionId: string, stop: Effect.Effect<A, E, R>) {
      return Effect.acquireUseRelease(
        Effect.sync(() => stops.set(sessionId, (stops.get(sessionId) ?? 0) + 1)),
        () => stop,
        () =>
          Effect.sync(() => {
            const count = stops.get(sessionId) ?? 0;
            if (count <= 1) stops.delete(sessionId);
            else stops.set(sessionId, count - 1);
          }),
      );
    },
  };
}
