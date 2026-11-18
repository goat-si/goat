import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ThreadId,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type { RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../ProjectionStore.ts";
import * as RunExecutionService from "../RunExecutionService.ts";

export const makeProviderRunControls = (
  projectionStore: ProjectionStore.ProjectionStoreV2Shape,
  idAllocator: { readonly derive: IdAllocator.IdAllocatorV2Derive },
) => {
  // Build draining callbacks outside startup scope so they cannot retain full thread history.
  const makeRunControls = (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: OrchestrationV2RunAttempt["id"];
    readonly providerThreadId: OrchestrationV2ProviderThread["id"];
    readonly runOrdinal: number;
    readonly worktreePath: string | null;
    readonly inheritedBackgroundTurnItems: ReturnType<
      typeof RunExecutionService.selectInheritedBackgroundTurnItems
    >;
  }) => {
    const isCurrentAttemptIn = (statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
      projectionStore
        .getRun(input.threadId, input.runId)
        .pipe(
          Effect.map(
            (run) => run?.activeAttemptId === input.attemptId && statuses.includes(run.status),
          ),
        );
    const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
      isCurrentAttemptIn([expectedStatus]);
    return {
      isCurrentAttemptInStatus,
      loadInheritedBackgroundTurnItems: () =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) =>
            RunExecutionService.selectInheritedBackgroundTurnItems({
              threadId: input.threadId,
              currentProviderThreadId: input.providerThreadId,
              currentRunOrdinal: input.runOrdinal,
              runs: current.runs,
              turnItems: current.turnItems,
            }),
          ),
          Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
        ),
      shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
      hasWorkspaceMoved: () =>
        projectionStore
          .getRuntimeRecoveryProjection(input.threadId)
          .pipe(Effect.map((current) => current.thread.worktreePath !== input.worktreePath)),
      shouldFinalizeRun: () => isCurrentAttemptIn(["starting", "running"]),
      hasUnpairedRunInterruptRequest: () =>
        projectionStore
          .hasUnpairedRunInterruptRequest(
            input.threadId,
            idAllocator.derive.runSignalTurnItem({
              runId: input.runId,
              signal: "interrupt-request",
            }),
            idAllocator.derive.runSignalTurnItem({
              runId: input.runId,
              signal: "interrupt-result",
            }),
          )
          .pipe(Effect.catchCause(() => Effect.succeed(false))),
      loadRunInterruptReason: () =>
        projectionStore
          .getThreadRecords(input.threadId, ["turnItems"], {
            turnItemTypes: ["run_interrupt_request"],
            turnItemRunIds: [input.runId],
          })
          .pipe(
            Effect.map(({ turnItems }) => {
              const request = turnItems.find((item) => item.type === "run_interrupt_request");
              return request?.type === "run_interrupt_request" ? request.message : undefined;
            }),
            // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
    };
  };

  return makeRunControls;
};
