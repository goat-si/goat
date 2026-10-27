/**
 * Whether a person is directing the turn that is about to get computer use.
 *
 * Unattended turns come from GOAT Bot, channel tasks, scheduled and webhook tasks, messages
 * another unattended thread sent, and threads such a turn launched or delegated to. They get the
 * driver only through an approved lease or full access (ComputerUseLeases). Threads launched from
 * another environment, and turns they launch or send here, are `launched_remotely`: in full
 * access they use the screen like a person's (usesScreenLikePerson). Every read that fails or
 * runs out of lineage counts as unattended.
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
  /** Read only to weigh steering against what full access gave the running turn. */
  readonly runtimeMode?: string | undefined;
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
  /** The server wrote it for another computer's agent answering a question here. */
  readonly foreignAnswer?: boolean | undefined;
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
export interface DirectedReads extends OriginReads {
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
/** A remote launch stays one through every send and launch it makes on this host. */
const unattendedVia = (from: ComputerUseOrigin, reason: UnattendedReason) =>
  unattended(
    from._tag === "unattended" && from.reason === "launched_remotely"
      ? "launched_remotely"
      : reason,
  );

/**
 * Whether this turn uses the screen like a person's thread. A remote launcher cannot be read
 * here; in full access its threads do too (owner decision, Jun, 2026-10-28). Steering and other
 * modes still see them as unattended.
 */
export const usesScreenLikePerson = (
  origin: ComputerUseOrigin,
  runtimeMode: string | undefined,
): boolean =>
  origin._tag === "interactive" ||
  (origin.reason === "launched_remotely" && runtimeMode === "full-access");

/** How much of the screen a turn of this origin gets without asking; an unread origin counts as `unknown`. */
const reach = (origin: ComputerUseOrigin, runtimeMode: string | undefined, unknown: number) =>
  origin._tag === "interactive"
    ? 2
    : origin.reason === "unknown"
      ? unknown
      : usesScreenLikePerson(origin, runtimeMode)
        ? 1
        : 0;
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
    if (message.foreignAnswer === true) return unattended("launched_remotely");
    if (message.senderThreadId !== undefined) {
      const sender = yield* classify(
        reads,
        message.senderThreadId,
        (runs) => runAt(runs, message.createdAt),
        depth + 1,
      );
      if (sender._tag === "unattended") return unattendedVia(sender, "sent_by_unattended");
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
    if (parent._tag === "unattended") return unattendedVia(parent, "launched_by_unattended");
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
/** The message the orchestrator writes for an answer to a question that resumes by message. */
const ASYNC_ANSWER = /^async-answer:(.+)$/;

/**
 * Whether a person, or an agent a person directs, caused this run, so full access gives it the
 * foreground without asking: a person's client sent its message; an agent sent it from a run that
 * was itself directed; a launch or an answer from another environment started it; or it is the
 * wake for a computer use approval such a run asked for. Server wakes and other server messages
 * are not, so a schedule's continuation never gains the foreground. Any failed read, or a chain
 * longer than lineage allows, is false.
 */
export const directedRun = Effect.fn("ComputerUse.directedRun")(
  function* (reads: DirectedReads, input: { readonly threadId: ThreadId; readonly runId: RunId }) {
    let threadId = input.threadId;
    let runId = input.runId;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const origin = yield* computerUseOrigin(reads, { threadId, runId });
      const remote = origin._tag === "unattended" && origin.reason === "launched_remotely";
      if (origin._tag !== "interactive" && !remote) return false;
      const run = (yield* reads.runs(threadId)).find((candidate) => candidate.id === runId);
      if (run === undefined) return false;
      const message = yield* reads.message(threadId, run.userMessageId);
      if (
        message === undefined ||
        message.scheduledTaskId !== undefined ||
        message.channel !== undefined
      )
        return false;
      if (message.senderThreadId !== undefined) {
        // An agent's message carries what the run that sent it had.
        const sender = runAt(yield* reads.runs(message.senderThreadId), message.createdAt);
        if (sender === undefined) return false;
        threadId = message.senderThreadId;
        runId = sender.id;
        continue;
      }
      if (fromPersonClient(message) || message.foreignAnswer === true) return true;
      // The launcher's own message in a thread another environment launched.
      if (remote && message.createdBy === "agent" && message.creationSource === "mcp") return true;
      // Only the wake reactor writes agent messages from the server under these ids.
      const wake =
        message.createdBy === "agent" && message.creationSource === "server"
          ? APPROVAL_WAKE.exec(run.userMessageId)
          : null;
      const asking = wake?.[1] === undefined ? undefined : yield* reads.grantRun(threadId, wake[1]);
      if (asking === undefined) return false;
      runId = asking;
    }
    return false;
  },
  Effect.catchCause(() => Effect.succeed(false)),
);

interface OriginTurnItem {
  readonly id: string;
  readonly runId: RunId | null;
  readonly handoff?: Pick<Handoff, "state" | "target" | "requestedBy"> | undefined;
}

interface OriginRuntimeRequest {
  readonly id: string;
  readonly respondedBy?:
    | { readonly type: "user" }
    | { readonly type: "agent"; readonly environmentId: string | null }
    | { readonly type: "client" }
    | undefined;
}

/** The projection reads every caller has, as classification reads. */
export const projectionOriginReads = <E1, E2>(deps: {
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<"runs" | "messages" | "turnItems" | "runtimeRequests">,
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
      readonly runtimeRequests?: ReadonlyArray<OriginRuntimeRequest>;
    },
    E1
  >;
  readonly channelOrigin: (
    threadId: ThreadId,
  ) => Effect.Effect<"goat_bot" | "channel_task" | undefined, E2>;
}): DirectedReads => ({
  channelOrigin: (id) => originRead(deps.channelOrigin(id)),
  thread: (id) =>
    originRead(deps.getThreadRecords(id, []).pipe(Effect.map((records) => records.thread))),
  runs: (id) =>
    originRead(
      deps.getThreadRecords(id, ["runs"]).pipe(Effect.map((records) => records.runs ?? [])),
    ),
  message: (id, messageId) =>
    originRead(
      Effect.gen(function* () {
        const records = yield* deps.getThreadRecords(id, ["messages"], { messageIds: [messageId] });
        const message = records.messages?.find((candidate) => candidate.id === messageId);
        const requestId = ASYNC_ANSWER.exec(messageId)?.[1];
        if (
          message === undefined ||
          requestId === undefined ||
          message.senderThreadId !== undefined ||
          message.createdBy !== "agent" ||
          message.creationSource !== "server"
        )
          return message;
        // The answer's message names no sender, so its request says who answered.
        const { runtimeRequests } = yield* deps.getThreadRecords(id, ["runtimeRequests"]);
        const by = runtimeRequests?.find((request) => request.id === requestId)?.respondedBy;
        return by?.type === "agent" && by.environmentId !== null
          ? { ...message, foreignAnswer: true }
          : message;
      }),
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
 * Whether a message whose own turn would have origin `message` may join the running turn
 * `targetRunId`: steering keeps that turn's starting message, so the attachment decision would
 * never see the new instruction. It may when it reaches at least as much of the screen; a turn or
 * thread that cannot be read could hold any reach, so nothing joins it.
 */
export const steeringAllowed = Effect.fn("ComputerUse.steeringAllowed")(function* (
  reads: OriginReads,
  input: {
    readonly threadId: ThreadId;
    readonly message: ComputerUseOrigin;
    readonly targetRunId: RunId;
  },
) {
  if (input.message._tag === "interactive") return true;
  const target = yield* computerUseOrigin(reads, {
    threadId: input.threadId,
    runId: input.targetRunId,
  });
  const thread = yield* reads.thread(input.threadId).pipe(Effect.orElseSucceed(() => undefined));
  if (thread === undefined) return false;
  return reach(input.message, thread.runtimeMode, 0) >= reach(target, thread.runtimeMode, 2);
});

/**
 * A scheduled or unattended message into a person's turn, or into a remote launch's full access
 * turn, waits as that thread's next turn instead, which this message starts and which is admitted
 * on its own (steeringAllowed). Steering between equals stays.
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
  const sender =
    input.senderThreadId === undefined || input.scheduledTaskId !== undefined
      ? unattended("scheduled_task")
      : yield* computerUseOrigin(reads, { threadId: input.senderThreadId });
  // The origin the message's own turn would have in this thread.
  const message =
    sender._tag === "interactive" || input.scheduledTaskId !== undefined
      ? sender
      : unattendedVia(sender, "sent_by_unattended");
  if (
    yield* steeringAllowed(reads, {
      threadId: input.threadId,
      message,
      targetRunId: mode.targetRunId,
    })
  )
    return { mode, queued: false } as const;
  return {
    mode: { type: "queue_after_active", behindRunId: mode.targetRunId },
    queued: true,
  } as const;
});
