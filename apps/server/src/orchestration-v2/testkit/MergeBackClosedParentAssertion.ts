import { assert } from "@effect/vitest";
import { CommandId, type RunId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { OrchestratorV2Shape } from "../Orchestrator.ts";

export const assertMergeBackClosedParent = Effect.fn("assertMergeBackClosedParent")(function* (
  orchestrator: OrchestratorV2Shape,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourceRunId: RunId,
) {
  for (const action of ["archive", "delete"] as const) {
    yield* orchestrator.dispatch({
      type: action === "archive" ? "thread.archive" : "thread.delete",
      commandId: CommandId.make(`merge-parent-${action}`),
      threadId: targetThreadId,
    });
    const error = yield* orchestrator
      .dispatch({
        type: "thread.merge_back",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make(`merge-parent-${action}-rejected`),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
      })
      .pipe(Effect.flip);
    assert.equal(error.cause, `Thread ${targetThreadId} is archived or deleted.`);
  }
});
