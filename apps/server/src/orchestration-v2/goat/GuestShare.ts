import type {
  CommandId,
  GuestMessageId,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import {
  decideGuestMessageSend,
  decideGuestShareCommand,
  releasedGuestAttachmentIds,
  type GuestShareCommand,
} from "../GuestShareDecider.ts";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

/**
 * The Orchestrator closures guest share commands need. The Orchestrator passes its error
 * classes in so this module never imports it at runtime.
 */
export interface GuestShareDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/** Guest share commands and the guest message send that commits with its message. */
export const makeGuestShare = (deps: GuestShareDeps) => {
  const { projectionStore, emit, OrchestratorDispatchError, OrchestratorProjectionError } = deps;

  // Deleted after the share change commits: the files of waiting messages it dismissed or dropped.
  const releaseGuestAttachments = (
    command: { readonly commandId: CommandId; readonly threadId: ThreadId },
    before: OrchestrationV2AppThread["guestShare"],
    after: OrchestrationV2AppThread["guestShare"],
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => {
    const attachmentIds = releasedGuestAttachmentIds(before ?? null, after ?? null);
    return attachmentIds.length === 0
      ? Effect.void
      : Ref.update(effects, (existing) => [
          ...existing,
          {
            id: `effect:${command.commandId}:guest-attachment.cleanup`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: { type: "attachment.cleanup", attachmentIds: [...attachmentIds] },
          } satisfies PendingOrchestrationEffectV2,
        ]);
  };

  const dispatchGuestShare = Effect.fn("orchestrationV2.dispatch.guestShare")(function* (
    command: GuestShareCommand,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, [])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const thread = projection.thread;
    const now = yield* DateTime.now;
    const decided =
      thread.deletedAt !== null
        ? Result.fail(`Thread ${command.threadId} is deleted.`)
        : decideGuestShareCommand({
            thread,
            command,
            now,
          });
    if (Result.isFailure(decided)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: decided.failure,
      });
    }
    if (decided.success === thread) return;
    yield* emit(
      events,
      command,
    )({
      type: "thread.guest-share-updated",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: decided.success,
    });
    yield* releaseGuestAttachments(command, thread.guestShare, decided.success.guestShare, effects);
  });

  // Emitted before the message so the send and the status change commit together, and so
  // `dispatchMessage`, which reads pending events, keeps the updated share.
  const emitGuestMessageSent = Effect.fn("orchestrationV2.dispatch.guestMessageSent")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    guestMessageId: GuestMessageId,
    thread: OrchestrationV2AppThread,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const now = yield* DateTime.now;
    const decided = decideGuestMessageSend({ thread, guestMessageId, now });
    if (Result.isFailure(decided)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: decided.failure,
      });
    }
    yield* emit(
      events,
      command,
    )({
      type: "thread.guest-share-updated",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: decided.success.thread,
    });
    return decided.success;
  });

  return { releaseGuestAttachments, dispatchGuestShare, emitGuestMessageSent };
};
