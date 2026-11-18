import * as Effect from "effect/Effect";
import type {
  OpenCodeChildExecution,
  OpenCodeSubagentContext,
  OpenCodeThreadState,
  TerminalTurnStatus,
} from "./adapterState.ts";

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
    claim(sessionId: string, resumed: boolean): OpenCodeChildExecution {
      const outcome = resumed ? undefined : outcomes.get(sessionId);
      outcomes.delete(sessionId);
      return { awaitingStart: resumed, outcome };
    },
    start(execution: OpenCodeChildExecution | undefined) {
      if (execution !== undefined) execution.awaitingStart = false;
    },
    observe(
      sessionId: string,
      status: TerminalTurnStatus,
      execution?: OpenCodeChildExecution,
      finalized = false,
    ) {
      if (execution?.awaitingStart && !finalized) return;
      const prior = execution === undefined ? outcomes.get(sessionId) : execution.outcome;
      const outcome = finalized
        ? status
        : (prior ?? (isStopping(sessionId) ? "interrupted" : status));
      if (execution !== undefined) {
        execution.outcome = outcome;
        return outcome;
      }
      if (!outcomes.has(sessionId) && outcomes.size >= MAX_UNCORRELATED_OUTCOMES) {
        const oldest = outcomes.keys().next();
        if (!oldest.done) outcomes.delete(oldest.value);
      }
      outcomes.set(sessionId, outcome);
      return outcome;
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

export function isChildCallUnder(context: OpenCodeSubagentContext, sessionId: string): boolean {
  for (
    let owner: OpenCodeThreadState | undefined = context.parentState;
    owner;
    owner = owner.parentSubagent?.parentState
  ) {
    if (owner.nativeSessionId === sessionId) return true;
  }
  return false;
}
