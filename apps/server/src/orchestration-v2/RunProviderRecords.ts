import type { NodeId, RunId, ThreadId, OrchestrationV2ThreadProjection } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { ProjectionStoreV2Shape, ProjectionStoreV2Error } from "./ProjectionStore.ts";
import { selectThreadRecords } from "./goat/ProjectionStoreMemoryReads.ts";

type Read = ProjectionStoreV2Shape["getThreadRecords"];
export const readRunProviderRecords = Effect.fn("ProjectionStore.readRunProviderRecords")(
  function* (read: Read, threadId: ThreadId, runId: RunId, nodeId: NodeId) {
    const controls = yield* read(threadId, ["runs", "nodes"], {
      runIds: [runId],
      nodeIds: [nodeId],
    });
    const run = controls.runs[0];
    const attemptIds = run?.activeAttemptId == null ? [] : [run.activeAttemptId];
    const records = yield* read(threadId, ["providerThreads", "providerTurns", "attempts"], {
      providerThreadIds: run?.providerThreadId == null ? [] : [run.providerThreadId],
      providerTurnAttemptIds: attemptIds,
      attemptIds,
    });
    const attemptTurnId = records.attempts[0]?.providerTurnId;
    if (records.providerTurns.length > 0 || attemptTurnId == null)
      return { ...controls, ...records };
    const { providerTurns } = yield* read(threadId, ["providerTurns"], {
      providerTurnIds: [attemptTurnId],
    });
    return { ...controls, ...records, providerTurns };
  },
);

export const readRunCardRecords = Effect.fn("ProjectionStore.readRunCardRecords")(function* (
  read: Read,
  threadId: ThreadId,
  runId: RunId,
  nodeId: NodeId,
) {
  const records = yield* readRunProviderRecords(read, threadId, runId, nodeId);
  const { turnItems } = yield* read(threadId, ["turnItems"], {
    turnItemTypes: ["secret_request", "human_handoff"],
  });
  return { ...records, turnItems };
});

export type RunProviderRead = (
  threadId: ThreadId,
  runId: RunId,
  nodeId: NodeId,
) => ReturnType<typeof readRunProviderRecords>;
export type RunCardRead = (
  threadId: ThreadId,
  runId: RunId,
  nodeId: NodeId,
) => ReturnType<typeof readRunCardRecords>;

export function makeReplayRecordReads<
  S extends { readonly projections: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection> },
>(state: Ref.Ref<S>, notFound: (threadId: ThreadId) => ProjectionStoreV2Error) {
  const records: Read = Effect.fn("ProjectionStore.getThreadRecords")(
    function* (threadId, fields, filter) {
      const projection = (yield* Ref.get(state)).projections.get(threadId);
      if (projection === undefined) return yield* notFound(threadId);
      return selectThreadRecords(projection, fields, filter);
    },
  );
  return {
    getThreadRecords: records,
    getRunProviderRecords: (threadId: ThreadId, runId: RunId, nodeId: NodeId) =>
      readRunProviderRecords(records, threadId, runId, nodeId),
    getRunCardRecords: (threadId: ThreadId, runId: RunId, nodeId: NodeId) =>
      readRunCardRecords(records, threadId, runId, nodeId),
  };
}
