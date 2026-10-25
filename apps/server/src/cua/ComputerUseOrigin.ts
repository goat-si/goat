/**
 * Whether a person is directing the turn that is about to get computer use.
 *
 * Unattended turns come from GOAT Bot, channel tasks, scheduled and webhook tasks, messages
 * another unattended thread sent, and threads such a turn launched or delegated to. They get the
 * driver only through an approved lease (ComputerUseLeases). Every read that fails or runs out of
 * lineage counts as unattended, so a lookup error never hands out the screen.
 *
 * @module ComputerUseOrigin
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type Handoff,
  type MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isChannelWorkerThreadId } from "../channels/channelIds.ts";

export class ComputerUseOriginError extends Schema.TaggedError<ComputerUseOriginError>()(
  "ComputerUseOriginError",
  { cause: Schema.Defect() },
) {}

/** Wraps a read's own failure; classification treats any failure as unattended. */
const originRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new ComputerUseOriginError({ cause })));

export type UnattendedReason =
  | "goat_bot"
  | "channel_task"
  | "channel_message"
  | "scheduled_task"
  | "sent_by_unattended"
  | "launched_by_unattended"
  | "launched_remotely"
  | "unknown";

export type ComputerUseOrigin =
  | { readonly _tag: "interactive" }
  | { readonly _tag: "unattended"; readonly reason: UnattendedReason };

export interface OriginThread {
  readonly createdAt: DateTime.Utc;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
  readonly launchedBy?:
    | {
        readonly kind: "launch" | "promotion";
        readonly threadId: ThreadId;
        readonly environmentId: string | null;
      }
    | undefined;
}

export interface OriginRun {
  readonly id: RunId;
  readonly userMessageId: MessageId;
  readonly requestedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc | null;
}

export interface OriginMessage {
  readonly createdAt: DateTime.Utc;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: ThreadId | undefined;
  readonly channel?: unknown;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
}

/** Reads a classification needs; each failure or absence fails closed. */
export interface OriginReads {
  readonly channelOrigin: (
    threadId: ThreadId,
  ) => Effect.Effect<"goat_bot" | "channel_task" | undefined, ComputerUseOriginError>;
  readonly thread: (
    threadId: ThreadId,
  ) => Effect.Effect<OriginThread | undefined, ComputerUseOriginError>;
  readonly runs: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OriginRun>, ComputerUseOriginError>;
  readonly message: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<OriginMessage | undefined, ComputerUseOriginError>;
}

/** Classification reads plus the run that asked for an approved computer use grant. */
export interface PersonStartReads extends OriginReads {
  readonly grantRun: (
    threadId: ThreadId,
    handoffId: string,
  ) => Effect.Effect<RunId | undefined, ComputerUseOriginError>;
}

const INTERACTIVE: ComputerUseOrigin = { _tag: "interactive" };
const unattended = (reason: UnattendedReason): ComputerUseOrigin => ({
  _tag: "unattended",
  reason,
});
// Lineage longer than this is not a person's thread tree; stop and treat it as unattended.
const MAX_DEPTH = 8;

const millis = DateTime.toEpochMillis;

/** The run that was in progress at `at`, else the last one requested before it. */
const runAt = (runs: ReadonlyArray<OriginRun>, at: DateTime.Utc): OriginRun | undefined => {
  const time = millis(at);
  const started = runs.filter((run) => millis(run.requestedAt) <= time);
  return (
    started.find((run) => run.completedAt === null || millis(run.completedAt) >= time) ??
    started.at(-1)
  );
};

const classify: (
  reads: OriginReads,
  threadId: ThreadId,
  pick: (runs: ReadonlyArray<OriginRun>) => OriginRun | undefined | "missing",
  depth: number,
) => Effect.Effect<ComputerUseOrigin, ComputerUseOriginError> = Effect.fn(
  "ComputerUse.classifyOrigin",
)(function* (reads, threadId, pick, depth) {
  if (depth > MAX_DEPTH) return unattended("unknown");
  // Known from the id the thread was created with, so it holds before the ledger binds it.
  if (isChannelWorkerThreadId(threadId)) return unattended("channel_task");
  const channel = yield* reads.channelOrigin(threadId);
  if (channel !== undefined) return unattended(channel);
  const thread = yield* reads.thread(threadId);
  if (thread === undefined) return unattended("unknown");

  const run = pick(yield* reads.runs(threadId));
  if (run === "missing") return unattended("unknown");
  if (run !== undefined) {
    const message = yield* reads.message(threadId, run.userMessageId);
    if (message === undefined) return unattended("unknown");
    if (message.scheduledTaskId !== undefined) return unattended("scheduled_task");
    if (message.channel !== undefined) return unattended("channel_message");
    if (message.senderThreadId !== undefined) {
      const sender = yield* classify(
        reads,
        message.senderThreadId,
        (runs) => runAt(runs, message.createdAt),
        depth + 1,
      );
      if (sender._tag === "unattended") return unattended("sent_by_unattended");
    }
  }

  // A thread another agent started inherits the turn that started it. A person promoting a
  // delegated task, or forking a thread, takes it over.
  const launcher =
    thread.launchedBy?.kind === "launch"
      ? thread.launchedBy
      : thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId
        ? { threadId: thread.lineage.parentThreadId, environmentId: null }
        : undefined;
  if (launcher !== undefined) {
    if (launcher.environmentId !== null) return unattended("launched_remotely");
    const parent = yield* classify(
      reads,
      launcher.threadId,
      (runs) => runAt(runs, thread.createdAt),
      depth + 1,
    );
    if (parent._tag === "unattended") return unattended("launched_by_unattended");
  }
  return INTERACTIVE;
});

/**
 * Classifies the run about to start or continue. Without a run id it uses the thread's latest
 * run, which is the one a session opens for.
 */
export const computerUseOrigin = (
  reads: OriginReads,
  input: { readonly threadId: ThreadId; readonly runId?: RunId | undefined },
): Effect.Effect<ComputerUseOrigin> =>
  classify(
    reads,
    input.threadId,
    (runs) =>
      input.runId === undefined
        ? runs.at(-1)
        : (runs.find((run) => run.id === input.runId) ?? "missing"),
    0,
  ).pipe(
    Effect.catchCause(() => Effect.succeed(unattended("unknown"))),
    Effect.withSpan("ComputerUse.origin"),
  );

/** What a person's client writes on a message it sends; server and MCP paths write others. */
const fromPersonClient = (message: OriginMessage) =>
  message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile");

/** The wake HandoffWakeReactor sends when a person approves a computer use request. */
const APPROVAL_WAKE = /^message:handoff-wake:(.+):completed$/;

/**
 * Whether a person caused this run: a person's client sent its message, or it is the wake for a
 * computer use approval that such a run asked for. Full access gives these runs every app and
 * foreground input without asking. Classification can call other runs interactive too (a task's
 * completion wake), which keep the approvals they had. Any failed read, or a chain longer than
 * lineage allows, is false.
 */
export const personStarted = (
  reads: PersonStartReads,
  input: { readonly threadId: ThreadId; readonly runId: RunId },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    let runId = input.runId;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const origin = yield* computerUseOrigin(reads, { threadId: input.threadId, runId });
      if (origin._tag !== "interactive") return false;
      const run = (yield* reads.runs(input.threadId)).find((candidate) => candidate.id === runId);
      if (run === undefined) return false;
      const message = yield* reads.message(input.threadId, run.userMessageId);
      if (
        message === undefined ||
        message.scheduledTaskId !== undefined ||
        message.channel !== undefined ||
        message.senderThreadId !== undefined
      )
        return false;
      if (fromPersonClient(message)) return true;
      // Only the wake reactor writes agent messages from the server under these ids.
      const wake =
        message.createdBy === "agent" && message.creationSource === "server"
          ? APPROVAL_WAKE.exec(run.userMessageId)
          : null;
      const asking =
        wake?.[1] === undefined ? undefined : yield* reads.grantRun(input.threadId, wake[1]);
      if (asking === undefined) return false;
      runId = asking;
    }
    return false;
  }).pipe(
    Effect.catchCause(() => Effect.succeed(false)),
    Effect.withSpan("ComputerUse.personStarted"),
  );

interface OriginTurnItem {
  readonly id: string;
  readonly runId: RunId | null;
  readonly handoff?: Pick<Handoff, "state" | "target" | "requestedBy"> | undefined;
}

/** The projection reads both callers have, as classification reads. */
export const projectionOriginReads = <E1, E2>(deps: {
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<"runs" | "messages" | "turnItems">,
    filter?: {
      readonly messageIds?: ReadonlyArray<MessageId>;
      readonly turnItemTypes?: ReadonlyArray<"human_handoff">;
      readonly turnItemStatuses?: ReadonlyArray<"completed">;
    },
  ) => Effect.Effect<
    {
      readonly thread: OriginThread;
      readonly runs?: ReadonlyArray<OriginRun>;
      readonly messages?: ReadonlyArray<OriginMessage & { readonly id: MessageId }>;
      readonly turnItems?: ReadonlyArray<OriginTurnItem>;
    },
    E1
  >;
  readonly channelOrigin: (
    threadId: ThreadId,
  ) => Effect.Effect<"goat_bot" | "channel_task" | undefined, E2>;
}): PersonStartReads => ({
  channelOrigin: (id) => originRead(deps.channelOrigin(id)),
  thread: (id) =>
    originRead(deps.getThreadRecords(id, []).pipe(Effect.map((records) => records.thread))),
  runs: (id) =>
    originRead(
      deps.getThreadRecords(id, ["runs"]).pipe(Effect.map((records) => records.runs ?? [])),
    ),
  message: (id, messageId) =>
    originRead(
      deps
        .getThreadRecords(id, ["messages"], { messageIds: [messageId] })
        .pipe(
          Effect.map((records) => records.messages?.find((message) => message.id === messageId)),
        ),
    ),
  grantRun: (id, handoffId) =>
    originRead(
      deps
        .getThreadRecords(id, ["turnItems"], {
          turnItemTypes: ["human_handoff"],
          turnItemStatuses: ["completed"],
        })
        .pipe(
          Effect.map((records) => {
            const item = records.turnItems?.find((candidate) => candidate.id === handoffId);
            const handoff = item?.handoff;
            return handoff?.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
              handoff.state === "completed" &&
              handoff.requestedBy.threadId === id
              ? (item?.runId ?? undefined)
              : undefined;
          }),
        ),
    ),
});

type SteeringMode =
  | { readonly type: "steer_active"; readonly targetRunId: RunId }
  | { readonly type: "restart_active"; readonly targetRunId: RunId };

/**
 * A message from an unattended origin (a scheduled task, or a thread that classifies as
 * unattended) must not join a turn a person is running: that turn may hold the direct driver,
 * and steering keeps the turn's starting message, so the attachment decision would never see
 * the new instruction. It waits as that thread's next turn instead, which this message starts
 * and which gets computer use only through a lease. Steering into an unattended turn stays,
 * since that turn has no direct driver.
 */
export const gateUnattendedSteering = Effect.fn("ComputerUse.gateUnattendedSteering")(function* (
  reads: OriginReads,
  input: {
    readonly threadId: ThreadId;
    readonly scheduledTaskId?: string | undefined;
    readonly senderThreadId?: ThreadId | undefined;
  },
  mode: SteeringMode,
) {
  if (input.scheduledTaskId === undefined && input.senderThreadId === undefined)
    return { mode, queued: false } as const;
  const provenance =
    input.senderThreadId === undefined
      ? unattended("scheduled_task")
      : input.scheduledTaskId !== undefined
        ? unattended("scheduled_task")
        : yield* computerUseOrigin(reads, { threadId: input.senderThreadId });
  if (provenance._tag === "interactive") return { mode, queued: false } as const;
  const target = yield* computerUseOrigin(reads, {
    threadId: input.threadId,
    runId: mode.targetRunId,
  });
  if (target._tag === "unattended") return { mode, queued: false } as const;
  return {
    mode: { type: "queue_after_active", behindRunId: mode.targetRunId },
    queued: true,
  } as const;
});
