import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { questionIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import type { ChannelLedgerError } from "./channelLedgerError.ts";

/** Sees each automatic placement's fiber as it starts; tests await the placement through it. */
export const PlacementStarted = Context.Reference<
  (fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
>("goat/channels/ChannelDispatcher/PlacementStarted", { defaultValue: () => () => Effect.void });

/**
 * Drops a version-fenced task write that another writer beat since the read it was decided from:
 * the task moved on, and the next pass decides again from a fresh read. Any other error stays.
 */
export const unlessMovedOn = <A, R>(write: Effect.Effect<A, ChannelLedgerError, R>) =>
  write.pipe(
    Effect.catchIf(
      (error) => error.reason === "version_conflict",
      (error) =>
        Effect.logDebug("channel task write dropped: the task moved on", { detail: error.detail }),
    ),
  );

export const askRequester = Effect.fn("channel.askRequester")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  text: string,
  owner: string,
  options: {
    readonly choices?: ReadonlyArray<string>;
  } = {},
) {
  const askedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* unlessMovedOn(
    commitTransition(
      ledger,
      stored,
      {
        type: "task.question.opened",
        payload: {
          question: {
            questionId: questionIdFor(stored.task.taskId, stored.task.version + 1),
            text,
            askedAt,
            ...(options.choices === undefined || options.choices.length < 2
              ? {}
              : { options: options.choices }),
            ...(stored.task.requester.externalActorId === undefined
              ? {}
              : { requesterExternalActorId: stored.task.requester.externalActorId }),
          },
        },
      },
      {
        owner,
        narrate: true,
      },
    ),
  );
});
