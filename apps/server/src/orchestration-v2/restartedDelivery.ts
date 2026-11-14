import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import type { RunId, OrchestrationV2UserMessageInputIntent } from "@goat/contracts";
import type { OrchestratorV2DispatchResult } from "./Orchestrator.ts";

function restartedAsNextTurn(dispatch: OrchestratorV2DispatchResult, runId: RunId) {
  return dispatch.storedEvents.some(
    ({ event }) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "run_interrupt_request" &&
      event.payload.runId !== runId,
  );
}

export function deliveryForDispatch(
  dispatch: OrchestratorV2DispatchResult,
  runId: RunId,
  inputIntent: OrchestrationV2UserMessageInputIntent | null,
  restart: boolean,
) {
  if (restart && restartedAsNextTurn(dispatch, runId)) return "restarted" as const;
  if (inputIntent === null || inputIntent === "queued_turn") return "queued" as const;
  if (inputIntent === "turn_start") return "started" as const;
  return restart ? ("restarted" as const) : ("steered" as const);
}

export function readRestartReceipt(
  receipts: import("./CommandReceiptStore.ts").CommandReceiptStoreV2Shape,
  input: import("./ThreadManagementService.ts").ThreadManagementSendInput,
  ProjectionError: typeof import("./ThreadManagementService.ts").ThreadManagementProjectionLoadError,
) {
  if (input.mode !== "restart") return Effect.succeed(false);
  return receipts.getByCommandId(input.commandId).pipe(
    Effect.map(Option.isSome),
    Effect.mapError(
      (cause) =>
        new ProjectionError({ projectId: input.projectId, threadId: input.threadId, cause }),
    ),
  );
}
