import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2DelegatedCompletionDelivery,
  RunId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../ProjectionStore.ts";

// The enclosing write or commit span already traces this per-event projection merge.
export const makeDelegatedCompletionUpdater = (
  projectionStore: ProjectionStore.ProjectionStoreV2["Service"],
) =>
  Effect.fnUntraced(function* (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    includesRun: (runId: RunId) => boolean,
  ) {
    return yield* Effect.forEach(events, (event) =>
      Effect.gen(function* () {
        if (event.type !== "run.updated" || !includesRun(event.payload.id)) return event;
        const { runs } = yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
          runIds: [event.payload.id],
        });
        const current = runs[0];
        return current === undefined
          ? event
          : {
              ...event,
              payload: { ...current, delegatedCompletion: event.payload.delegatedCompletion },
            };
      }),
    );
  });

export const completionDeliveryRun = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) => {
  if (delivery == null) return undefined;
  const message = projection.messages.find((candidate) => candidate.id === delivery.messageId);
  return projection.runs.find((candidate) => candidate.id === message?.runId);
};

export const completionDeliveryMessage = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
) =>
  delivery === null || delivery === undefined
    ? undefined
    : projection.messages.find((candidate) => candidate.id === delivery.messageId);
