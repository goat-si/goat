/**
 * Builds and commits task transitions with the deliveries every transition needs: the GOAT bot
 * chip for the task's new version, plus whatever the caller adds.
 *
 * @module channelTaskWrites
 */
import {
  type ChannelBotRef,
  type ChannelReplyAddress,
  type ChannelTask,
  type ChannelTaskChip,
  ChannelTaskEvent,
  type ChannelTaskEventId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor, taskEventIdFor } from "./channelIds.ts";
import { applyChannelTaskEvent } from "./channelTaskTransitions.ts";

const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);

export type ChannelTaskEventSpec = {
  readonly [Type in ChannelTaskEvent["type"]]: {
    readonly type: Type;
    readonly payload: Extract<ChannelTaskEvent, { readonly type: Type }>["payload"];
  };
}[ChannelTaskEvent["type"]];

/** The event that moves `task` to its next version. */
export const makeTaskEvent = (
  task: ChannelTask,
  spec: ChannelTaskEventSpec,
  occurredAt: string,
  options: {
    readonly actor?: "user" | "agent" | "system";
    readonly eventId?: ChannelTaskEventId;
  } = {},
): ChannelTaskEvent =>
  decodeEvent({
    eventId: options.eventId ?? taskEventIdFor(task.taskId, task.version + 1),
    sequence: 0,
    taskId: task.taskId,
    taskVersion: task.version + 1,
    occurredAt,
    actor: options.actor ?? "system",
    type: spec.type,
    payload: spec.payload,
  });

const chipFor = (task: ChannelTask): ChannelTaskChip => ({
  taskId: task.taskId,
  conversationId: task.conversationId,
  taskVersion: task.version,
  title: task.title,
  status: task.status,
  originKind: task.requester.originKind,
  requesterLabel: task.requester.displayName,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  ...(task.worker === undefined
    ? {}
    : { worker: { environmentId: task.worker.environmentId, threadId: task.worker.threadId } }),
  ...(task.resultSummary === undefined ? {} : { summary: task.resultSummary }),
  openQuestionCount: task.openQuestions.length,
});

export const botAddress = (bot: ChannelBotRef): ChannelReplyAddress => ({
  kind: "goat",
  environmentId: bot.environmentId,
  threadId: bot.threadId,
});

/** The chip delivery for one task version; re-committing the same version adds nothing. */
export const chipDelivery = (
  task: ChannelTask,
  bot: ChannelBotRef,
): ChannelLedger.ChannelOutboxInsert => {
  const causeKey = "chip:" + task.taskId + ":" + task.version;
  const deliveryId = deliveryIdFor(causeKey);
  return {
    deliveryId,
    causeKey,
    taskId: task.taskId,
    message: {
      deliveryId,
      destination: botAddress(bot),
      kind: "task_chip",
      text: task.title,
      taskId: task.taskId,
      taskVersion: task.version,
      chip: chipFor(task),
    },
  };
};

export interface TransitionOptions {
  readonly owner?: string | undefined;
  readonly narrate?: boolean;
  readonly forward?: boolean;
  readonly pendingAnswerMessageId?: string | null;
  readonly completionHold?: string | null;
  readonly deliveries?: ReadonlyArray<ChannelLedger.ChannelOutboxInsert>;
  readonly actor?: "user" | "agent" | "system";
  readonly eventId?: ChannelTaskEventId;
  /** Changes to the next snapshot the state machine does not make itself. */
  readonly amend?: (next: ChannelTask) => ChannelTask;
}

export const prepareTransition = (
  stored: ChannelLedger.ChannelStoredTask,
  spec: ChannelTaskEventSpec,
  occurredAt: string,
  bot: ChannelBotRef | undefined,
  options: TransitionOptions = {},
) => {
  const event = makeTaskEvent(stored.task, spec, occurredAt, {
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
  });
  const transition = applyChannelTaskEvent(stored.task, event);
  if (!transition.ok) return { ok: false as const, reason: transition.reason };
  const next = options.amend === undefined ? transition.task : options.amend(transition.task);
  const write: ChannelLedger.ChannelTaskEventWrite = {
    next,
    expectedVersion: stored.task.version,
    event,
    ...(options.narrate === undefined ? {} : { narrate: options.narrate }),
    ...(options.forward === undefined ? {} : { forward: options.forward }),
    ...(options.pendingAnswerMessageId === undefined
      ? {}
      : { pendingAnswerMessageId: options.pendingAnswerMessageId }),
    ...(options.completionHold === undefined ? {} : { completionHold: options.completionHold }),
  };
  const deliveries = [
    ...(bot === undefined ? [] : [chipDelivery(next, bot)]),
    ...(options.deliveries ?? []),
  ];
  return { ok: true as const, write, deliveries, next, event };
};

/**
 * Applies one transition. A transition the state machine refuses is logged and skipped: it means
 * another writer already moved the task, which is not this caller's error to report.
 */
export const commitTransition = Effect.fn("channel.commitTransition")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  spec: ChannelTaskEventSpec,
  options: TransitionOptions = {},
) {
  const bot = yield* ledger.getBot(stored.ownerId);
  const occurredAt = DateTime.formatIso(yield* DateTime.now);
  const prepared = prepareTransition(stored, spec, occurredAt, bot?.bot, options);
  if (!prepared.ok) {
    yield* Effect.logDebug("channel task transition skipped", {
      taskId: stored.task.taskId,
      type: spec.type,
      reason: prepared.reason,
    });
    return undefined;
  }
  yield* ledger.applyTaskEvent({
    owner: options.owner,
    write: prepared.write,
    deliveries: prepared.deliveries,
  });
  return prepared.next;
});
