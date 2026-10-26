import { remapComposerContextAttachments } from "@goat/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import type { ChatAttachment, OrchestrationV2Command } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";
import * as ChannelGateway from "../channels/ChannelGateway.ts";
import type { ChannelConnectionOwner } from "../channels/ChannelIngressContext.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import { ChannelGatewayError } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorQuestionAlreadyAnsweredError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "ThreadManagementProviderInstanceDisabledError":
      return true;
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A §message.dispatch§ to the GOAT bot becomes channel input: stored by the gateway and answered
 * by reception, never a provider turn. The result reports the orchestration sequence that
 * recorded the user's message, which is what older clients wait for.
 */
const dispatchToBot = Effect.fn("ThreadMessageIntake.dispatchToBot")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  owner: ChannelConnectionOwner | undefined,
) {
  if (owner === undefined) return yield* new ChannelGatewayError({ reason: "forbidden" });
  // The bot timeline has no attachment field yet, so the bot takes text only.
  if (command.attachments.length > 0) {
    return yield* new ChannelGatewayError({ reason: "invalid_input" });
  }
  const ledgerOption = yield* Effect.serviceOption(ChannelLedger.ChannelLedger);
  const gatewayOption = yield* Effect.serviceOption(ChannelGateway.ChannelGateway);
  if (Option.isNone(ledgerOption) || Option.isNone(gatewayOption)) {
    return yield* new ChannelGatewayError({ reason: "adapter_unavailable" });
  }
  const ledger = ledgerOption.value;
  const gateway = gatewayOption.value;
  const bot = yield* ledger
    .getBot(owner.ownerId)
    .pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));
  if (bot === undefined || bot.bot.threadId !== command.threadId) {
    return yield* new ChannelGatewayError({ reason: "forbidden" });
  }
  const receivedAt = DateTime.formatIso(yield* DateTime.now);
  const result = yield* gateway.ingest(
    {
      kind: "goat",
      connectionId: ChannelGateway.GOAT_CONNECTION_ID,
      conversationKey: command.threadId,
      externalMessageId: command.messageId,
      idempotencyKey: command.commandId,
      actor: {},
      replyAddress: {
        kind: "goat",
        environmentId: bot.bot.environmentId,
        threadId: command.threadId,
      },
      text: command.text,
      attachments: [],
      receivedAt,
      intent: "message",
    },
    { ...owner, caller: { type: "intake", commandId: command.commandId } },
  );
  return { sequence: result.timelineSequence ?? 0, storedEvents: [] };
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  command: OrchestrationV2Command,
  channelOwner?: ChannelConnectionOwner,
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const withGuestAttachments = Effect.fn("ThreadMessageIntake.withGuestAttachments")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return command;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  const message = projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
  return { ...command, attachments: message?.attachments ?? [] };
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
) {
  const command =
    incoming.type === "message.dispatch" ? yield* withGuestAttachments(incoming) : incoming;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Servers assembled without the channel layer (some tests) have no GOAT bot to route to.
  const botDirectory = yield* Effect.serviceOption(ChannelBotDirectory.ChannelBotDirectory);
  if (command.type === "message.dispatch" && Option.isSome(botDirectory)) {
    const isBot = yield* botDirectory.value.isBotThread(command.threadId);
    if (isBot) return yield* dispatchToBot(command, channelOwner);
  }
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@goat/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.tap((result) => {
          // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
          // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  return yield* threads
    .dispatch({
      ...command,
      attachments: claimed.attachments,
      ...(command.context
        ? {
            context: remapComposerContextAttachments(
              command.context,
              command.attachments ?? [],
              claimed.attachments,
            ),
          }
        : {}),
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Refused before any thread existed.
        if (error._tag === "ThreadLaunchWorkspaceMissingError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede message dispatch. The create-thread error
        // also wraps post-message projection reads, so its tag alone is not proof.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
