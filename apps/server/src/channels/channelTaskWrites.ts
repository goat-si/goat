/**
 * Builds and commits task transitions with the deliveries every transition needs: the GOAT bot
 * chip for the task's new version, plus whatever the caller adds.
 *
 * @module channelTaskWrites
 */
import {
  type ChannelBindingId,
  type ChannelBotRef,
  type ChannelConversationId,
  type ChannelInputId,
  type ChannelReceptionAction,
  type ChannelReplyAddress,
  type ChannelRequester,
  type ChannelTask,
  type ChannelTaskChip,
  ChannelTaskEvent,
  type ChannelTaskEventId,
  isGoatBotSessionThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor, taskEventIdFor, taskIdFor } from "./channelIds.ts";
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
    payload:
      spec.type === "task.completed" ||
      spec.type === "task.failed" ||
      spec.type === "task.cancelled"
        ? {
            ...spec.payload,
            ...(task.briefVersion === undefined ? {} : { briefVersion: task.briefVersion }),
          }
        : spec.payload,
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
    : {
        worker: {
          environmentId: task.worker.environmentId,
          threadId: task.worker.threadId,
          ...(task.worker.host === undefined ? {} : { host: task.worker.host }),
          // A session thread serves several tasks; the run tells this one's activity apart.
          ...(task.worker.runId === undefined || !isGoatBotSessionThreadId(task.worker.threadId)
            ? {}
            : { runId: task.worker.runId }),
        },
      }),
  ...(task.target?.placementReason === undefined
    ? {}
    : { placementReason: task.target.placementReason }),
  ...(task.movedFrom === undefined ? {} : { movedFrom: task.movedFrom }),
  // A turn's summary is GOAT Bot's answer, which the conversation already shows as a message.
  ...(task.resultSummary === undefined || task.kind === "turn"
    ? {}
    : { summary: task.resultSummary }),
  openQuestionCount: task.openQuestions.length,
  ...(task.completionReport === undefined ? {} : { completionReport: task.completionReport }),
  ...(task.observed === undefined ? {} : { observed: task.observed }),
});

export const botAddress = (bot: ChannelBotRef): ChannelReplyAddress => ({
  kind: "goat",
  environmentId: bot.environmentId,
  threadId: bot.threadId,
});

/**
 * The chip delivery for one task version; re-committing the same version adds nothing. A
 * different `causeKey` delivers the same card for another reason, such as being a task's outcome.
 */
export const chipDelivery = (
  task: ChannelTask,
  bot: ChannelBotRef,
  causeKey = "chip:" + task.taskId + ":" + task.version,
): ChannelLedger.ChannelOutboxInsert => {
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
  /** A remote worker state change committed with the event. */
  readonly remoteWorker?: ChannelLedger.RemoteWorkerStateUpdate;
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
    ...(options.remoteWorker === undefined ? {} : { remoteWorker: options.remoteWorker }),
  });
  return prepared.next;
});

/** Builds the ledger task(s) and initial events a `create_task` or `run_turn` reception commits. */
export const makeCreatedTasks = (input: {
  readonly action: Extract<ChannelReceptionAction, { readonly type: "create_task" | "run_turn" }>;
  readonly inputId: ChannelInputId;
  readonly conversationId: ChannelConversationId;
  readonly originBindingId: ChannelBindingId;
  readonly originAddress: ChannelReplyAddress;
  readonly requester: ChannelRequester;
  readonly notesChangeRequested?: ChannelTask["notesChangeRequested"] | undefined;
  readonly includePrimary?: boolean | undefined;
  readonly bot?: ChannelBotRef | undefined;
  readonly deliveries?: Array<ChannelLedger.ChannelOutboxInsert> | undefined;
  readonly now: string;
}): ReadonlyArray<{ readonly task: ChannelTask; readonly event: ChannelTaskEvent }> => {
  const specs: ReadonlyArray<{
    readonly index: number;
    readonly title: ChannelTask["title"];
    readonly instruction: string;
    readonly kind?: ChannelTask["kind"] | undefined;
    readonly projectId?: ChannelTask["projectId"] | undefined;
    readonly host?: ChannelTask["host"] | undefined;
    readonly notesChangeRequested?: ChannelTask["notesChangeRequested"] | undefined;
  }> = [
    ...(input.includePrimary === false
      ? []
      : [
          {
            index: 0,
            title: input.action.title,
            instruction: input.action.instruction,
            ...(input.action.type === "run_turn" ? { kind: "turn" as const } : {}),
            ...(input.action.type !== "create_task" || input.action.projectId === undefined
              ? {}
              : { projectId: input.action.projectId }),
            ...(input.action.type !== "create_task" || input.action.host === undefined
              ? {}
              : { host: input.action.host }),
            ...(input.notesChangeRequested === undefined
              ? {}
              : { notesChangeRequested: input.notesChangeRequested }),
          },
        ]),
    ...(input.action.additionalTasks ?? []).map((spec, idx) => ({ ...spec, index: idx + 1 })),
  ];
  return specs.map((spec) => {
    const taskId = taskIdFor(input.inputId, spec.index);
    const task: ChannelTask = {
      taskId,
      ...(spec.kind === undefined ? {} : { kind: spec.kind }),
      conversationId: input.conversationId,
      originBindingId: input.originBindingId,
      originAddress: input.originAddress,
      originInputId: input.inputId,
      requester: input.requester,
      title: spec.title,
      instruction: spec.instruction,
      status: "received",
      version: 1,
      generation: 1,
      ...(spec.projectId === undefined ? {} : { projectId: spec.projectId }),
      ...(spec.host === undefined ? {} : { host: spec.host }),
      ...(spec.notesChangeRequested === undefined
        ? {}
        : { notesChangeRequested: spec.notesChangeRequested }),
      openQuestions: [],
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (input.bot !== undefined && input.deliveries !== undefined) {
      input.deliveries.push(chipDelivery(task, input.bot));
    }
    return {
      task,
      event: makeTaskEvent(
        { ...task, version: 0 },
        {
          type: "task.created",
          payload: {
            title: task.title,
            instruction: task.instruction,
            originInputId: input.inputId,
            ...(task.notesChangeRequested === undefined
              ? {}
              : { notesChangeRequested: task.notesChangeRequested }),
          },
        },
        input.now,
        { eventId: taskEventIdFor(taskId, 1) },
      ),
    };
  });
};

const movedNarration = (payload: { fromHost: string; host: string; replicaCapturedAt: string }) =>
  `${payload.fromHost} stopped answering, so this continues on ${payload.host} from the copy of its work taken at ${payload.replicaCapturedAt}. Whatever it does on ${payload.fromHost} after that stays there.`;

/** Base narration text and outbound kind for a pending task event, or undefined when silent. */
export const narrationFor = (
  task: ChannelTask,
  event: ChannelLedger.ChannelPendingEvent["event"],
) => {
  switch (event.type) {
    case "task.dispatch.claimed":
      return event.payload.target.placementReason === undefined
        ? undefined
        : {
            kind: "receipt" as const,
            text: task.title + " → " + event.payload.target.placementReason,
          };
    case "task.completed":
      if (task.kind === "turn") {
        return {
          kind: "result" as const,
          text: event.payload.summary.trim() === "" ? "Done." : event.payload.summary,
        };
      }
      return {
        kind: "result" as const,
        text:
          "Done: " +
          task.title +
          (event.payload.summary.trim() === "" ? "" : "\n" + event.payload.summary),
      };
    case "task.failed":
      return {
        kind: "failure" as const,
        text:
          "Couldn't finish: " + task.title + ": " + (event.payload.summary ?? event.payload.reason),
      };
    case "task.progress":
      return event.payload.milestone === true
        ? { kind: "receipt" as const, text: event.payload.summary }
        : undefined;
    case "task.moved":
      return { kind: "receipt" as const, text: movedNarration(event.payload) };
    case "task.cancelled":
      return { kind: "failure" as const, text: "Stopped: " + task.title };
    case "task.question.opened":
      return {
        kind: "question" as const,
        text: event.payload.question.text,
        options: event.payload.question.options,
      };
    default:
      return undefined;
  }
};
