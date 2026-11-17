import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../../sourceControl/threadPullRequests.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { endingWakeText, pullRequestWatchNote } from "./PullRequestDigest.ts";
import { pullRequestWakeMuted } from "./PullRequestWatchWakes.ts";

type WatchSync = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.pull-request-watch.sync" }
>;
type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type Effects = Ref.Ref<Array<PendingOrchestrationEffectV2>>;

export interface PullRequestWatchSyncDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Events,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly dispatchThreadMutation: (
    command: WatchSync,
    events: Events,
    effects: Effects,
  ) => Effect.Effect<unknown, OrchestratorV2Error>;
  readonly dispatchMessage: (
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Events,
    effects: Effects,
  ) => Effect.Effect<unknown, OrchestratorV2Error>;
  readonly dropQueuedPullRequestWakes: (
    command: WatchSync,
    events: Events,
    headSha?: string,
  ) => Effect.Effect<unknown, OrchestratorV2Error>;
  /** Passed in so this module never imports the Orchestrator at runtime. */
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
}

export const makePullRequestWatchSync = ({
  projectionStore,
  emit,
  dispatchThreadMutation,
  dispatchMessage,
  dropQueuedPullRequestWakes,
  OrchestratorProjectionError,
  OrchestratorDispatchError,
}: PullRequestWatchSyncDeps) => {
  // Recheck under the lock after reading the host. Record the watch first so wake events carry it.
  const dispatchPullRequestWatchSync = Effect.fn("orchestrationV2.dispatch.pullRequestWatchSync")(
    function* (
      command: Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "thread.pull-request-watch.sync" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const key = normalizeThreadPullRequestKey(command);
      const link = threadPullRequestsOf(thread).find(
        (candidate) =>
          candidate.source !== "stack-dismissed" && threadPullRequestKeysEqual(candidate, key),
      );
      if (
        link?.watch?.startedAt !== command.startedAt ||
        (command.wake && pullRequestWakeMuted(thread, link, command.watch !== null))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "The watch ended, its thread settled, or the pull request merged while it was read.",
        });
      }
      yield* dispatchThreadMutation(command, events, effects);
      if (command.dropQueuedWakes === true) yield* dropQueuedPullRequestWakes(command, events);
      else if (command.watch?.headSha != null && command.watch.headSha !== link.watch.headSha)
        yield* dropQueuedPullRequestWakes(command, events, command.watch.headSha);
      if (command.wake === undefined) {
        if (command.note === undefined) return;
        // Kept as context: the timeline shows it, and no turn starts.
        const ordinal = yield* projectionStore
          .getNextTurnItemOrdinal(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        const note = pullRequestWatchNote(command, command.note, ordinal, yield* DateTime.now);
        yield* emit(events, command)(note);
        return;
      }
      yield* dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: command.threadId,
          messageId: command.wake.messageId,
          // An ending watch tells what it kept, as stored now rather than when the host was read.
          text:
            command.watch === null
              ? endingWakeText(command.wake.text, link.watch, command.endedWatch)
              : command.wake.text,
          notification: command.wake.notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        },
        events,
        effects,
      );
    },
  );

  return { dispatchPullRequestWatchSync };
};
