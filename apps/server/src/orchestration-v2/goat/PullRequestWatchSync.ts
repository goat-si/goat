import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2Notification,
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
import { type Notice, renderDigest } from "../TurnDigest.ts";
import { endingWakeText, pullRequestWatchNote } from "./PullRequestDigest.ts";
import { pullRequestWakeMuted } from "./PullRequestWatchWakes.ts";

type WatchSync = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.pull-request-watch.sync" }
>;
type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type Effects = Ref.Ref<Array<PendingOrchestrationEffectV2>>;

/** One wake's notification for news on several pull requests: failed if any failed. */
function combinedNotification(
  notifications: ReadonlyArray<OrchestrationV2Notification>,
): OrchestrationV2Notification {
  const outcomes = notifications.map((notification) => notification.outcome);
  return {
    source: { kind: "monitor" },
    outcome: outcomes.includes("failed")
      ? "failed"
      : outcomes.every((outcome) => outcome === "completed")
        ? "completed"
        : "updated",
    summary: notifications
      .map((notification) => notification.summary)
      .join("; ")
      .slice(0, 160),
  };
}

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
      const { others = [], ...primary } = command;
      const entries = [
        primary,
        ...others.map((other) => ({
          ...other,
          type: primary.type,
          commandId: primary.commandId,
          threadId: primary.threadId,
        })),
      ].map((entry) => {
        const key = normalizeThreadPullRequestKey(entry);
        const link = threadPullRequestsOf(thread).find(
          (candidate) =>
            candidate.source !== "stack-dismissed" && threadPullRequestKeysEqual(candidate, key),
        );
        return { entry, link };
      });
      // One wake cannot leave out just some of its pull requests; the reader then sends each alone.
      if (
        entries.some(
          ({ entry, link }) =>
            link?.watch?.startedAt !== entry.startedAt ||
            (entry.wake && pullRequestWakeMuted(thread, link, entry.watch !== null)),
        )
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause:
            "The watch ended, its thread settled, or the pull request merged while it was read.",
        });
      }
      const notices: Array<Notice> = [];
      const notifications: Array<OrchestrationV2Notification> = [];
      for (const [index, { entry, link }] of entries.entries()) {
        const stored = link?.watch;
        if (stored === undefined) continue;
        yield* dispatchThreadMutation(entry, events, effects);
        if (entry.dropQueuedWakes === true) yield* dropQueuedPullRequestWakes(entry, events);
        else if (entry.watch?.headSha != null && entry.watch.headSha !== stored.headSha)
          yield* dropQueuedPullRequestWakes(entry, events, entry.watch.headSha);
        if (entry.wake !== undefined) {
          notices.push({
            id: entry.wake.messageId,
            // An ending watch tells what it kept, as stored now rather than when the host was read.
            text:
              entry.watch === null
                ? endingWakeText(entry.wake.text, stored, entry.endedWatch)
                : entry.wake.text,
          });
          notifications.push(entry.wake.notification);
          continue;
        }
        if (entry.note === undefined) continue;
        // Kept as context: the timeline shows it, and no turn starts.
        const ordinal = yield* projectionStore
          .getNextTurnItemOrdinal(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        const noted = index === 0 ? entry : { ...entry, commandId: `${entry.commandId}:${index}` };
        const note = pullRequestWatchNote(noted, entry.note, ordinal + index, yield* DateTime.now);
        yield* emit(events, command)(note);
      }
      const messageId = entries.find(({ entry }) => entry.wake !== undefined)?.entry.wake
        ?.messageId;
      const [notification, ...more] = notifications;
      if (messageId === undefined || notification === undefined) return;
      yield* dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: command.threadId,
          messageId,
          // Several pull requests' news is one digest, so dropping one later keeps the others.
          text: renderDigest(messageId, notices),
          notification: more.length === 0 ? notification : combinedNotification(notifications),
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
