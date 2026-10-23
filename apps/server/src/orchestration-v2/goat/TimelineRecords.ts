import {
  CommandId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { ChannelBotDirectoryError } from "../../channels/ChannelBotDirectory.ts";
import { timelineIdsFor } from "../../channels/channelIds.ts";
import type {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

/** The GOAT bot answers through its reception service; it never runs a coding turn. */
export class OrchestratorChannelBotThreadError extends Schema.TaggedError<OrchestratorChannelBotThreadError>()(
  "OrchestratorChannelBotThreadError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return "This thread is the GOAT bot. Send it messages through the GOAT bot chat or goat_channel_ingest.";
  }
}

/**
 * The Orchestrator closures that runless timeline records need. The Orchestrator
 * passes its error classes in so this module never imports it at runtime.
 */
export interface TimelineRecordDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly botDirectory: {
    readonly isBotThread: (threadId: ThreadId) => Effect.Effect<boolean, ChannelBotDirectoryError>;
  };
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly OrchestratorCommandRejectedError: typeof OrchestratorCommandRejectedError;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/** Thread notices and GOAT bot channel records: timeline items that start no run. */
export const makeTimelineRecords = (deps: TimelineRecordDeps) => {
  const {
    projectionStore,
    botDirectory,
    emit,
    OrchestratorCommandRejectedError,
    OrchestratorDispatchError,
    OrchestratorProjectionError,
  } = deps;

  const dispatchThreadNoticeRecord = Effect.fn("orchestrationV2.dispatch.threadNoticeRecord")(
    function* (
      command: Extract<OrchestrationV2InternalCommand, { readonly type: "thread.notice.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (thread.deletedAt !== null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} is deleted.`,
        });
      }
      // The length-prefixed thread id keeps record keys distinct across threads and channels.
      const itemId = TurnItemId.make(
        `thread-notice:${command.threadId.length}:${command.threadId}:${command.recordKey}`,
      );
      const existing = yield* projectionStore
        .getTurnItem({ threadId: command.threadId, itemId })
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      // Position allocation orders a runless item before the first run, so attach the notice to
      // the latest run the timeline still shows: it then lands after everything visible so far.
      const { runs } = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs"])
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const latestRun = runs
        .filter((run) => run.status !== "rolled_back")
        .reduce<(typeof runs)[number] | undefined>(
          (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
          undefined,
        );
      const ordinal =
        existing?.ordinal ??
        (yield* projectionStore
          .getNextTurnItemOrdinal(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          ));
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: {
          id: itemId,
          threadId: command.threadId,
          runId: existing?.runId ?? latestRun?.id ?? null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: existing?.startedAt ?? now,
          completedAt: existing?.completedAt ?? now,
          updatedAt: now,
          type: "system_notice",
          message: command.message,
          ...(command.severity === undefined ? {} : { severity: command.severity }),
        },
      });
    },
  );

  /**
   * One GOAT bot message or task chip, recorded without a run, provider session, or effect.
   * Ids come from the record key, so a redelivered record updates its own item in place.
   */
  const dispatchChannelTimelineRecord = Effect.fn("orchestrationV2.dispatch.channelTimelineRecord")(
    function* (
      command: Extract<
        OrchestrationV2InternalCommand,
        { readonly type: "channel.timeline.record" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const isBot = yield* botDirectory
        .isBotThread(command.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (!isBot) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Thread " + command.threadId + " is not the GOAT bot.",
        });
      }
      const { record } = command;
      const { messageId, turnItemId } = timelineIdsFor(command.threadId, record.recordKey, "");
      const existing = yield* projectionStore
        .getTurnItem({ threadId: command.threadId, itemId: turnItemId })
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const now = yield* DateTime.now;
      const ordinal =
        existing?.ordinal ??
        (yield* projectionStore
          .getNextTurnItemOrdinal(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          ));
      const base = {
        id: turnItemId,
        threadId: command.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt: existing?.startedAt ?? now,
        completedAt: existing?.completedAt ?? now,
        updatedAt: now,
      };
      const emitEvent = emit(events, command);
      const entry = record.entry;
      if (entry.type === "task_chip") {
        if (existing !== undefined && existing !== null && existing.type !== "notification") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Turn item " + turnItemId + " is not a task chip.",
          });
        }
        // An older chip arriving late never replaces a newer one: the current item is
        // recorded again unchanged, so the command still commits and stays idempotent.
        if (
          existing?.type === "notification" &&
          existing.ledgerTask !== undefined &&
          existing.ledgerTask.taskVersion >= entry.chip.taskVersion
        ) {
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: existing,
          });
          return;
        }
        const chip = entry.chip;
        const turnItem: OrchestrationV2TurnItem = {
          ...base,
          type: "notification",
          source: { kind: "background_task" },
          outcome:
            chip.status === "completed"
              ? "completed"
              : chip.status === "failed"
                ? "failed"
                : chip.status === "cancelled"
                  ? "cancelled"
                  : "updated",
          summary: chip.title,
          ...(chip.summary === undefined || chip.summary.trim() === ""
            ? {}
            : { detail: chip.summary }),
          ledgerTask: chip,
        };
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          occurredAt: now,
          payload: turnItem,
        });
        return;
      }
      if (
        existing !== undefined &&
        existing !== null &&
        existing.type !== (entry.role === "user" ? "user_message" : "assistant_message")
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Turn item " + turnItemId + " is not a " + entry.role + " message.",
        });
      }
      const createdBy = entry.role === "user" ? ("user" as const) : ("agent" as const);
      const message: OrchestrationV2ConversationMessage = {
        createdBy,
        creationSource: "server",
        channel: entry.meta,
        id: messageId,
        threadId: command.threadId,
        runId: null,
        nodeId: null,
        role: entry.role,
        text: entry.text,
        attachments: [],
        streaming: false,
        createdAt: base.startedAt,
        updatedAt: now,
      };
      const turnItem: OrchestrationV2TurnItem =
        entry.role === "user"
          ? {
              ...base,
              createdBy,
              creationSource: "server",
              type: "user_message",
              messageId,
              channel: entry.meta,
              // A channel input starts no provider turn; runId null marks it as runless.
              inputIntent: "turn_start",
              text: entry.text,
              attachments: [],
            }
          : {
              ...base,
              type: "assistant_message",
              messageId,
              channel: entry.meta,
              text: entry.text,
              streaming: false,
            };
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: message,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  /* Runs inside the message.dispatch span, ahead of the provider run it would start. */
  const refuseChannelOnlyMessage = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  ) {
    const isBot = yield* botDirectory
      .isBotThread(command.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (isBot) {
      return yield* new OrchestratorChannelBotThreadError({
        commandId: command.commandId,
        threadId: command.threadId,
      });
    }
    // Task chips come only from the channel ledger, through channel.timeline.record.
    if (command.notification?.ledgerTask !== undefined) {
      return yield* new OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Notifications sent as messages cannot carry a ledger task.",
      });
    }
  });

  return { dispatchThreadNoticeRecord, dispatchChannelTimelineRecord, refuseChannelOnlyMessage };
};
