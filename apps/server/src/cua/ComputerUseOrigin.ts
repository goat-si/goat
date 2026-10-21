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
import type { MessageId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ComputerUseOriginError extends Schema.TaggedError<ComputerUseOriginError>()(
  "ComputerUseOriginError",
  { cause: Schema.Defect() },
) {}

/** Wraps a read's own failure; classification treats any failure as unattended. */
export const originRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
