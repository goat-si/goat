import { CommandId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { OrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { OrchestrationEffectRequestV2 } from "../EffectOutboxRequest.ts";
import {
  ProviderTurnControlError,
  type ProviderTurnControlServiceV2Shape,
} from "../ProviderTurnControlService.ts";
import type { ThreadManagementServiceShape } from "../ThreadManagementService.ts";
import { OrchestrationEffectExecutionError } from "./EffectExecution.ts";

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

export const makeSteerEffect = (
  providerTurnControl: Pick<ProviderTurnControlServiceV2Shape, "steer">,
  threads: Pick<ThreadManagementServiceShape, "dispatch" | "getThreadRecords">,
) =>
  Effect.fn("OrchestrationEffectExecutorV2.steer")(function (
    effect: Pick<OrchestrationEffectV2, "id" | "threadId">,
    request: Extract<OrchestrationEffectRequestV2, { type: "provider-turn.steer" }>,
  ) {
    return providerTurnControl
      .steer({
        threadId: effect.threadId,
        providerSessionId: request.providerSessionId,
        providerThreadId: request.providerThreadId,
        providerTurnId: request.providerTurnId,
        messageId: request.messageId,
        modelSelection: request.modelSelection,
        ...(request.deferredSteer === undefined
          ? {}
          : { deferredAttemptId: request.deferredSteer.attemptId }),
      })
      .pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            const messageId = request.messageId;
            const projection = yield* threads.getThreadRecords(
              effect.threadId,
              ["messages", "runs"],
              { messageIds: [request.messageId] },
            );
            const message = projection.messages.find((row) => row.id === messageId);
            if (message?.delegatedCompletion === undefined) return;
            yield* threads.dispatch({
              type: "notification.delivery.accept",
              commandId: CommandId.make(`command:mailbox-accepted:${effect.id}`),
              threadId: effect.threadId,
              messageId: message.id,
            });
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!isProviderTurnControlError(error)) {
              return yield* error;
            }
            if (
              request.deferredSteer !== undefined &&
              (error.deferredSteerMissed || error.turnCompleted || error.steerDeclined)
            ) {
              yield* threads.dispatch({
                type: "deferred-steer.restore",
                commandId: CommandId.make(`command:restore-deferred-steer:${effect.id}`),
                threadId: effect.threadId,
                messageId: request.messageId,
                ...request.deferredSteer,
              });
              return;
            }
            if (!error.turnCompleted && !error.steerDeclined) return yield* error;
            const projection = yield* threads.getThreadRecords(
              effect.threadId,
              ["messages", "runs"],
              { messageIds: [request.messageId] },
            );
            const messageId = request.messageId;
            const message = projection.messages.find((item) => item.id === messageId);
            const run = projection.runs.find((item) => item.id === message?.runId);
            if (message === undefined || run === undefined) return yield* error;
            const modelSelection =
              request.pinnedScheduleSelection ??
              (error.steerDeclined ? request.modelSelection : undefined) ??
              (message.delegatedCompletion === undefined ? undefined : run.modelSelection);
            // Notifications must be queued messages.
            const queued =
              message.delegatedCompletion !== undefined ||
              message.notification !== undefined ||
              error.steerDeclined === true;
            // Reuse message ids and receipts so retries cannot duplicate messages or follow-ups.
            yield* threads
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`command:steer-follow-up:${effect.id}`),
                threadId: effect.threadId,
                messageId: message.id,
                memoryGrantCeiling: run.memoryGrantCeiling ?? "none",
                ...(error.steerDeclined ? { steerFollowUpOfRunId: run.id } : {}),
                ...(error.steerDeclined && request.steerFollowUpAfterRunOrdinal !== undefined
                  ? {
                      steerFollowUpAfterRunOrdinal: request.steerFollowUpAfterRunOrdinal,
                    }
                  : {}),
                text: message.text,
                ...(message.context ? { context: message.context } : {}),
                attachments: message.attachments,
                ...(modelSelection === undefined ? {} : { modelSelection }),
                dispatchMode: {
                  type: queued ? "queue_after_active" : "start_immediately",
                },
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.delegatedCompletion === undefined
                  ? {}
                  : { delegatedCompletion: message.delegatedCompletion }),
                ...(message.notification === undefined
                  ? {}
                  : { notification: message.notification }),
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              })
              .pipe(
                // A disabled instance cannot retry this completed turn; its result stands.
                Effect.catchTags({
                  ThreadManagementProviderInstanceDisabledError: (disabledError) =>
                    Effect.logInfo("orchestration-v2.effect-worker.steer-follow-up-disabled", {
                      threadId: effect.threadId,
                      messageId: message.id,
                      projectId: disabledError.projectId,
                      instanceId: disabledError.instanceId,
                    }),
                }),
              );
          }),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestrationEffectExecutionError({
              effectId: effect.id,
              effectType: request.type,
              cause,
            }),
        ),
      );
  });
