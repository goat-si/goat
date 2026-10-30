import {
  OrchestratorMcpFailure,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpReviewRound,
  type OrchestratorMcpTarget,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
} from "@goat/contracts";
import type { OrchestrationV2SessionCapabilities } from "@goat/contracts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import type * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import {
  isSlashPrompt,
  reviewContinuationRefusal,
  reviewRound,
} from "../orchestration-v2/goat/ReviewRoundEvidence.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { admitDelegate, releaseReservation } from "./childWorkAdmission.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";
import { stableCommandId } from "./stableCommandId.ts";

type Failure = OrchestratorMcpFailure;
const failure = (code: Failure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const TERMINAL = new Set<OrchestrationV2Subagent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** What goat_task_create's continueFrom path needs from OrchestratorMcpService. */
export interface ContinueReviewDeps {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly permissions: Profiles.PermissionProfiles["Service"];
  readonly sessionCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<OrchestrationV2SessionCapabilities, Failure>;
  /** Resolves target with the earlier reviewer's selection as the inheritance base. */
  readonly resolveTarget: (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    target: OrchestratorMcpTarget | undefined,
  ) => Effect.Effect<{ readonly modelSelection: ModelSelection }, Failure>;
  readonly resolveRuntimeMode: (
    parentMode: RuntimeMode,
    requested: RuntimeMode,
  ) => Effect.Effect<RuntimeMode, Failure>;
  readonly resolveInteractionMode: (
    parentMode: ProviderInteractionMode,
    requested: ProviderInteractionMode,
  ) => Effect.Effect<ProviderInteractionMode, Failure>;
  readonly requestKey: (clientRequestId: string | undefined) => Effect.Effect<string>;
  readonly finishTaskWait: (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    key: string,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, Failure>;
  readonly threadManagementFailure: (error: unknown) => Failure;
}

export interface ContinueReviewCall {
  readonly scope: McpThreadInvocationScope;
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">;
  readonly parentRun: {
    readonly id: RunId;
    readonly rootNodeId: NodeId;
  };
  readonly input: OrchestratorMcpDelegateTaskInput & { readonly continueFrom: NodeId };
  readonly memoryGrantCeiling: OrchestrationV2Subagent["memoryGrantCeiling"];
  readonly channelChildWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>;
  readonly commandReceipts: Option.Option<CommandReceiptStore.CommandReceiptStoreV2["Service"]>;
}

const errorText = (error: unknown) =>
  userFacingDispatchErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));

export const makeContinueReviewTask = (deps: ContinueReviewDeps) => {
  const { threadManagement, permissions } = deps;

  const loadChild = (threadId: OrchestrationV2Subagent["childThreadId"] & {}) =>
    threadManagement
      .getThreadRecords(
        threadId,
        ["runs", "attempts", "providerTurns", "providerThreads", "messages"],
        { messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(deps.threadManagementFailure));

  const continueReviewTask = Effect.fn("OrchestratorMcpService.continueReviewTask")(function* (
    call: ContinueReviewCall,
  ) {
    const { scope, parent, parentRun, input } = call;
    if (input.role !== "review")
      return yield* failure("invalid_request", "continueFrom requires role='review'.");
    if (input.target?.host !== undefined || input.remote !== undefined)
      return yield* failure(
        "invalid_request",
        "Continuing a review on another machine is not supported; start a fresh review round there.",
      );
    if (
      input.isolation !== undefined ||
      input.runtimeMode !== undefined ||
      input.interactionMode !== undefined
    )
      return yield* failure(
        "invalid_request",
        "continueFrom keeps the reviewer's checkout and modes; omit isolation, runtimeMode and interactionMode.",
      );
    if (isSlashPrompt(input.task))
      return yield* failure(
        "invalid_request",
        "A continued review round needs a written brief, not a slash command.",
      );
    const key = yield* deps.requestKey(input.clientRequestId);
    const commandId = stableCommandId({
      scope,
      requestKey: key,
      operation: "delegate-task-continue",
    });
    const taskId = derive.delegatedTaskNode({ commandId });
    const existing = parent.subagents.find((task) => task.id === taskId);
    if (existing !== undefined) {
      if (existing.continuedFrom !== input.continueFrom)
        return yield* failure(
          "invalid_request",
          "This clientRequestId already started a different review round; use a new one.",
        );
      return yield* deps.finishTaskWait(scope, taskId, key, input);
    }
    const earlier = parent.subagents.find(
      (task) =>
        task.id === input.continueFrom &&
        task.origin === "app_owned" &&
        task.threadId === parent.thread.id,
    );
    if (earlier === undefined)
      return yield* failure(
        "task_not_found",
        "Task " + input.continueFrom + " is not a delegated task of this thread.",
      );
    const childThreadId = earlier.childThreadId;
    if (childThreadId === null || earlier.remote !== undefined)
      return yield* failure(
        "invalid_request",
        "That review ran on another machine; continuing it is not supported. Start a fresh review round.",
      );
    const replay = yield* threadManagement.hasReceipt(commandId);
    const earlierSelection = earlier.modelSelection ?? {
      instanceId: earlier.providerInstanceId,
      model: earlier.model ?? "",
    };
    let modelSelection = earlierSelection;
    if (!replay) {
      if (earlier.role !== "review")
        return yield* failure("invalid_request", "continueFrom must name a role='review' task.");
      if (!TERMINAL.has(earlier.status))
        return yield* failure(
          "invalid_request",
          "That review round has not finished; wait for it before continuing.",
        );
      if (earlier.promotedAt !== undefined)
        return yield* failure(
          "invalid_request",
          "That reviewer's thread was promoted and no longer belongs to this thread.",
        );
      const child = yield* loadChild(childThreadId);
      if (child.thread.archivedAt !== null || child.thread.deletedAt !== null)
        return yield* failure("invalid_request", "That reviewer's thread is archived or deleted.");
      const refusal = reviewContinuationRefusal({
        child: { ...child, activeProviderThreadId: child.thread.activeProviderThreadId },
        earlier,
        isOriginal:
          child.thread.forkedFrom?.type === "node" && child.thread.forkedFrom.nodeId === earlier.id,
      });
      if (refusal !== undefined) return yield* failure("invalid_request", refusal);
      const resolved = yield* deps.resolveTarget(
        { thread: { ...parent.thread, modelSelection: earlierSelection } },
        input.target,
      );
      if (
        resolved.modelSelection.instanceId !== earlierSelection.instanceId ||
        resolved.modelSelection.model !== earlierSelection.model
      )
        return yield* failure(
          "invalid_request",
          "continueFrom keeps the reviewer's provider and model (" +
            earlierSelection.instanceId +
            "/" +
            earlierSelection.model +
            "). Omit target, or start a fresh review round for another model.",
        );
      modelSelection = resolved.modelSelection;
      const sessions = yield* deps.sessionCapabilities(modelSelection.instanceId);
      if (sessions.executionLocation === "cloud" || sessions.followUp?.supported === false)
        return yield* failure(
          "invalid_request",
          "Provider " +
            modelSelection.instanceId +
            " cannot continue a review in the same conversation; start a fresh review round.",
        );
      yield* deps.resolveRuntimeMode(parent.thread.runtimeMode, child.thread.runtimeMode);
      yield* deps.resolveInteractionMode(
        parent.thread.interactionMode,
        child.thread.interactionMode,
      );
      yield* permissions.require(scope, "threads.launch", {
        runtimeMode: parent.thread.runtimeMode,
      });
      const effective = yield* permissions.resolve(scope, parent.thread.runtimeMode);
      if (effective.enabled) {
        yield* deps.resolveRuntimeMode(effective.runtimeMode, child.thread.runtimeMode);
        yield* permissions.assertTarget(
          scope,
          childThreadId,
          parent.thread.runtimeMode,
          child.thread.runtimeMode,
        );
      }
      // Channel-owned callers count child work through their own ledger, which has no
      // continuation record; they start fresh rounds instead.
      const admission = yield* admitDelegate(call.channelChildWork, {
        callerThreadId: scope.thread.threadId,
        callerRunId: scope.thread.runId,
        prompt: input.task,
        clientRequestId: input.clientRequestId,
        target: input.target,
        role: input.role,
      });
      if (admission !== undefined) {
        if (admission._tag !== "existing")
          yield* releaseReservation(call.channelChildWork, admission);
        return yield* failure(
          "invalid_request",
          "continueFrom is not available to channel-owned threads; start a fresh review round.",
        );
      }
    }
    const admitted = yield* permissions.claim(scope, {
      id: commandId,
      childThreadId,
      runtimeMode: parent.thread.runtimeMode,
    });
    yield* threadManagement
      .dispatch({
        type: "delegated_task.review-continue",
        commandId,
        threadId: parent.thread.id,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        continueFrom: input.continueFrom,
        childThreadId,
        task: input.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        modelSelection,
        completionWake: input.mode === "wait" ? "settled_only" : "always",
        memoryGrantCeiling: call.memoryGrantCeiling ?? "none",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(
        // An accepted receipt means the round exists and keeps its claim; otherwise it returns.
        Effect.onError(() =>
          !admitted.enabled
            ? Effect.void
            : Option.match(call.commandReceipts, {
                onNone: () => Effect.void,
                onSome: (receipts) =>
                  receipts.getByCommandId(commandId).pipe(
                    Effect.flatMap((receipt) =>
                      Option.isSome(receipt) && receipt.value.status === "accepted"
                        ? Effect.void
                        : permissions.release(commandId, true),
                    ),
                    Effect.ignore,
                  ),
              }),
        ),
        Effect.mapError((error) =>
          error._tag === "OrchestratorDispatchError" ||
          error._tag === "OrchestratorCommandPreviouslyRejectedError" ||
          error._tag === "OrchestratorThreadAboveModeLimitError"
            ? failure("invalid_request", "Unable to continue the review: " + errorText(error))
            : error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? deps.threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  "Unable to continue the review: " + errorText(error),
                ),
        ),
      );
    if (admitted.enabled) yield* permissions.complete(commandId, childThreadId);
    return yield* deps.finishTaskWait(scope, taskId, key, input);
  });

  /** reviewRound for a review task's read result; remote rounds are always fresh reviewers. */
  const reviewRoundFor = Effect.fn("OrchestratorMcpService.reviewRoundFor")(function* (
    parent: Pick<OrchestrationV2ThreadProjection, "subagents">,
    task: OrchestrationV2Subagent,
  ) {
    const fresh: OrchestratorMcpReviewRound = {
      continuedFrom: null,
      conversation: "new",
      compacted: false,
    };
    if (task.childThreadId === null || task.remote !== undefined) return fresh;
    const child = yield* loadChild(task.childThreadId);
    const compactions = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["turnItems"], { turnItemTypes: ["compaction"] })
      .pipe(Effect.mapError(deps.threadManagementFailure));
    const earlier = parent.subagents.find((candidate) => candidate.id === task.continuedFrom);
    return reviewRound({
      child,
      task,
      earlier,
      earlierIsOriginal:
        earlier !== undefined &&
        child.thread.forkedFrom?.type === "node" &&
        child.thread.forkedFrom.nodeId === earlier.id,
      compactions: compactions.turnItems,
    });
  });

  return { continueReviewTask, reviewRoundFor };
};
