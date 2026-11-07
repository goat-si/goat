import { assert } from "@effect/vitest";
import { CommandId, RunId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Orchestrator from "./Orchestrator.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

export const staleSettlementAndItemStatuses = Effect.fn("test.staleSettlementAndItemStatuses")(
  function* (
    orchestrator: Orchestrator.OrchestratorV2["Service"],
    projections: ProjectionStore.ProjectionStoreV2["Service"],
    threadId: ThreadId,
  ) {
    const stale = yield* orchestrator
      .dispatch({
        type: "thread.settle",
        commandId: CommandId.make("stale-settlement"),
        threadId,
        expectedLatestRunId: RunId.make("run:settle-binding:1"),
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.isNull((yield* projections.getThreadProjection(threadId)).thread.settledAt);
    return Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
  },
);
