import { NodeId, RunAttemptId, RunId, ThreadId } from "@goat/contracts";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { EventSinkV2 } from "../EventSink.ts";
import type { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { makeSettleRunBeforeStart } from "../ProviderTurnStartSettlement.ts";
import { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";

export function makeFailedStartSettlement(input: {
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly eventSink: EventSinkV2["Service"];
  readonly idAllocator: IdAllocatorV2["Service"];
}) {
  return Effect.fn("ProviderTurnStartService.failStartingRun")(
    function* ({
      threadId,
      runId,
      attemptId,
      rootNodeId,
    }: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: RunAttemptId;
      readonly rootNodeId: NodeId;
    }) {
      const projection = yield* input.projectionStore.getTurnStartContext(threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (
        run?.status !== "starting" ||
        run.activeAttemptId !== attemptId ||
        run.rootNodeId !== rootNodeId
      )
        return;
      const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
      const rootNode = projection.nodes.find((candidate) => candidate.id === rootNodeId);
      if (attempt === undefined || rootNode === undefined)
        return yield* new ProviderTurnStartError({
          runId,
          cause: "Starting run is missing its execution state.",
        });
      yield* makeSettleRunBeforeStart({
        ...input,
        projection,
        run,
        rootNode,
        attempt,
        expectedStartStatus: "starting",
      })({
        signal: "provider-turn-start-failure",
        status: "failed",
        now: yield* DateTime.now,
        providerInstanceId: run.providerInstanceId,
        itemProviderThreadId: run.providerThreadId,
        item: {
          type: "error",
          title: "Turn failed to start",
          failure: makeProviderFailure({
            message:
              "GOAT could not start this turn. Send the message again; if it keeps failing, check the server logs.",
          }),
        },
      });
    },
    (effect, { runId }) =>
      effect.pipe(Effect.mapError((cause) => new ProviderTurnStartError({ runId, cause }))),
  );
}
